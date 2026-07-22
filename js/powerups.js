/* powerups.js — Power-Up-Sammlung (App.Powerups).
 *
 * Belohnungen aus dem Turnier (js/tournament.js) landen NICHT mehr sofort aktiv,
 * sondern als Gegenstand in der Sammlung des Spielers. Oben neben der
 * Coin-Anzeige (.topnav) gibt es einen ⚡-Knopf: dort tauchen alle Power-Ups
 * auf, die man besitzt. Ein Klick öffnet die Sammlung, dort wählt man eins aus
 * und benutzt es.
 *
 * Effekt-Arten (kind):
 *   luck     zeitlich begrenzter Gewinn-Multiplikator (wirkt über rigFactor in
 *            coins.js auf alle Gambling-Gewinne). Dauer in Sekunden.
 *   golden   „Goldene Hand": zeitlich begrenzt wird JEDER Verlust erstattet.
 *   freebet  Freispiel: die nächste Gambling-Runde ist risikofrei — verlierst
 *            du, bekommst du den Einsatz zurück (als hättest du nicht gespielt);
 *            gewinnst du, behältst du alles. Der Einsatz wird beim Freispiel
 *            automatisch auf Maximum vorbelegt (siehe createBetPanel in ui.js).
 *   shield   Verlust-Schild: die nächsten N Verlust-Runden werden erstattet.
 *   winmult  Gewinn-Verdoppler/-Verdreifacher: der nächste Gewinn zählt ×2/×3.
 *   coins    sofort Coins gutschreiben.
 *   tickets  sofort Turnier-Tickets gutschreiben.
 *   refill   Rettungsanker: füllt das Guthaben auf einen Mindestbetrag auf.
 *
 * Die Verlust-Erstattung (freebet/shield/golden) und der Gewinn-Multiplikator
 * (winmult) klinken sich zentral in coins.js ein (onRoundEnd bzw.
 * consumeWinBonus), damit sie ohne Eingriff in die einzelnen Spiele wirken.
 */
(function () {
  'use strict';
  window.App = window.App || {};

  var KEY_INV = 'gj_pu_inv';   // Sammlung (Array von Gegenständen)
  var KEY_FX = 'gj_pu_fx';     // laufende/scharfe Effekte

  /* Katalog. `param` steuert das Eingabefeld im Admin-Menü:
   *   'seconds' -> Dauer in Sekunden · 'amount' -> Menge · null -> fest. */
  var TYPES = [
    { id: 'luck3', icon: '🌟', label: 'Göttliches Glück', hint: 'Gewinne ×5', kind: 'luck', factor: 5, param: 'seconds' },
    { id: 'luck2', icon: '🍀', label: 'Extrem viel Glück', hint: 'Gewinne ×2.5', kind: 'luck', factor: 2.5, param: 'seconds' },
    { id: 'luck1', icon: '🙂', label: 'Etwas Glück', hint: 'Gewinne ×1.6', kind: 'luck', factor: 1.6, param: 'seconds' },
    { id: 'freebet', icon: '🎰', label: 'Freispiel', hint: 'nächste Runde risikofrei zum Max-Einsatz', kind: 'freebet', param: null },
    { id: 'golden', icon: '🌞', label: 'Goldene Hand', hint: 'jeder Verlust wird erstattet', kind: 'golden', param: 'seconds' },
    { id: 'shield', icon: '🛡️', label: 'Verlust-Schild', hint: 'die nächsten 3 Verluste zurück', kind: 'shield', rounds: 3, param: null },
    { id: 'double', icon: '✨', label: 'Gewinn-Verdoppler', hint: 'nächster Gewinn ×2', kind: 'winmult', mult: 2, param: null },
    { id: 'triple', icon: '🎯', label: 'Gewinn-Verdreifacher', hint: 'nächster Gewinn ×3', kind: 'winmult', mult: 3, param: null },
    { id: 'coins', icon: '🪙', label: 'Coin-Regen', hint: 'Coins sofort aufs Konto', kind: 'coins', param: 'amount' },
    { id: 'tickets', icon: '🎟️', label: 'Ticket-Paket', hint: 'Turnier-Tickets sofort', kind: 'tickets', param: 'amount' },
    { id: 'refill', icon: '🩹', label: 'Rettungsanker', hint: 'füllt dein Guthaben auf', kind: 'refill', param: 'amount' }
  ];

  function typeById(id) {
    for (var i = 0; i < TYPES.length; i++) if (TYPES[i].id === id) return TYPES[i];
    return null;
  }

  var listeners = [];
  function emit() {
    listeners.forEach(function (cb) { try { cb(); } catch (e) {} });
  }

  /* ---------------- Speicher ---------------- */
  function inv() {
    var v = App.Storage.get(KEY_INV, null);
    return Array.isArray(v) ? v : [];
  }
  function saveInv(a) { App.Storage.set(KEY_INV, a || []); }

  function fx() {
    var v = App.Storage.get(KEY_FX, null);
    if (!v || typeof v !== 'object') v = {};
    return {
      luck: v.luck && v.luck.type ? v.luck : null,   // {type, until}
      golden: v.golden || 0,                          // until (ms)
      freebet: !!v.freebet,
      shield: Math.max(0, Math.round(v.shield || 0)),
      winMult: Math.max(0, Math.round(v.winMult || 0)) // 0 | 2 | 3
    };
  }
  function saveFx(o) { App.Storage.set(KEY_FX, o); }

  /* ---------------- Dauer/Beschreibung ---------------- */
  function prizeSeconds(prize) {
    if (!prize) return 60;
    if (prize.seconds != null) return Math.max(1, Math.round(Number(prize.seconds) || 60));
    if (prize.minutes != null) return Math.max(1, Math.round(Number(prize.minutes) || 1)) * 60; // Altbestand
    return 60;
  }

  /** Beschreibung für Menüs/Sieger-Screen/Sammlung. prize = {type, seconds, amount}. */
  function describe(prize) {
    if (!prize || !prize.type) return 'kein Preis';
    var t = typeById(prize.type);
    if (!t) return 'kein Preis';
    if (t.kind === 'coins') return (prize.amount || 0) + ' 🪙 Coins';
    if (t.kind === 'tickets') return (prize.amount || 0) + ' 🎟️ Tickets';
    if (t.kind === 'refill') return 'Rettungsanker auf ' + (prize.amount || 0) + ' 🪙';
    if (t.param === 'seconds') return prizeSeconds(prize) + ' Sek. ' + t.label + ' (' + t.hint + ')';
    return t.label + ' — ' + t.hint;   // freebet/shield/double/triple (feste Wirkung)
  }

  /* ---------------- Laufende Effekte lesen (für coins.js/UI) ---------------- */
  function luckActive() {
    var f = fx();
    if (f.luck && f.luck.until > Date.now()) return f.luck;
    return null;
  }
  /** Gewinn-Faktor des laufenden Glücks-Power-Ups (1 = keins). Liest coins.js. */
  function factor() {
    var l = luckActive();
    if (!l) return 1;
    var t = typeById(l.type);
    return (t && t.factor) || 1;
  }
  function goldenActive() { return fx().golden > Date.now(); }
  function freebetArmed() { return fx().freebet; }

  /** true, wenn die laufende/nächste Runde durch ein Verlust-erstattendes Power-Up
   *  risikofrei ist (Freispiel / Verlust-Schild / Goldene Hand). Solche Runden
   *  dürfen KEINE Wager-/Gewinn-XP geben und nicht in die Quest-Statistik zählen —
   *  sonst wäre die garantierte Erstattung ein XP-Automat (progress.js prüft das). */
  function roundProtected() {
    var f = fx();
    return !!(f.freebet || f.shield > 0 || goldenActive());
  }

  function anyEffectActive() {
    var f = fx();
    return !!(luckActive() || goldenActive() || f.freebet || f.shield > 0 || f.winMult > 0);
  }

  function remainingMs(untilMs) { return Math.max(0, (untilMs || 0) - Date.now()); }
  function fmtRemaining(ms) {
    var s = Math.ceil(ms / 1000);
    var m = Math.floor(s / 60); s = s % 60;
    return m > 0 ? (m + ':' + String(s).padStart(2, '0')) : (s + 's');
  }

  /* ---------------- Sammlung ---------------- */
  function newIid() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /** Belohnung als Gegenstand in die Sammlung legen (Turniersieg). */
  function grant(prize) {
    if (!prize || !prize.type || !typeById(prize.type)) return '';
    var item = { iid: newIid(), type: prize.type };
    if (prize.seconds != null || prize.minutes != null) item.seconds = prizeSeconds(prize);
    if (prize.amount != null) item.amount = Math.max(0, Math.round(prize.amount));
    var a = inv(); a.push(item); saveInv(a);
    emit(); renderChip();
    return describe(prize);
  }

  function inventory() { return inv(); }

  /** Einen Gegenstand aus der Sammlung benutzen. Gibt true bei Erfolg. */
  function useItem(iid) {
    var a = inv();
    var idx = a.map(function (x) { return x.iid; }).indexOf(iid);
    if (idx < 0) return false;
    var item = a[idx];
    var t = typeById(item.type);
    if (!t) { a.splice(idx, 1); saveInv(a); return false; }

    var f = fx();
    var now = Date.now();
    var msg = '';

    if (t.kind === 'luck') {
      var secs = Math.max(1, Math.round(item.seconds || 60));
      // gleicher Typ -> verlängern, sonst neu setzen
      var base = (f.luck && f.luck.type === t.id && f.luck.until > now) ? f.luck.until : now;
      f.luck = { type: t.id, until: base + secs * 1000 };
      msg = t.icon + ' ' + t.label + ' aktiv (' + secs + ' Sek.)';
    } else if (t.kind === 'golden') {
      var gs = Math.max(1, Math.round(item.seconds || 60));
      var gbase = f.golden > now ? f.golden : now;
      f.golden = gbase + gs * 1000;
      msg = '🌞 Goldene Hand aktiv (' + gs + ' Sek.) — Verluste werden erstattet';
    } else if (t.kind === 'freebet') {
      f.freebet = true;
      msg = '🎰 Freispiel scharf — deine nächste Gambling-Runde ist gratis (Max-Einsatz)';
    } else if (t.kind === 'shield') {
      f.shield += (t.rounds || 3);
      msg = '🛡️ Verlust-Schild: die nächsten ' + f.shield + ' Verluste werden erstattet';
    } else if (t.kind === 'winmult') {
      f.winMult = Math.max(f.winMult, t.mult);
      msg = '✨ Nächster Gewinn zählt ×' + f.winMult;
    } else if (t.kind === 'coins') {
      var amt = Math.max(0, Math.round(item.amount || 0));
      if (App.Coins) (App.Coins.addRaw ? App.Coins.addRaw(amt) : App.Coins.add(amt));
      msg = '🪙 +' + amt + ' Coins';
    } else if (t.kind === 'tickets') {
      var tk = Math.max(0, Math.round(item.amount || 0));
      if (App.Tickets) App.Tickets.add(tk);
      msg = '🎟️ +' + tk + ' Tickets';
    } else if (t.kind === 'refill') {
      var target = Math.max(0, Math.round(item.amount || 0));
      if (App.Coins) {
        var cur = App.Coins.get();
        if (cur < target) (App.Coins.addRaw ? App.Coins.addRaw(target - cur) : App.Coins.add(target - cur));
      }
      msg = '🩹 Guthaben auf ' + target + ' 🪙 aufgefüllt';
    }

    a.splice(idx, 1); saveInv(a);
    saveFx(f);
    emit(); renderChip();
    if (App.UI && App.UI.toast) App.UI.toast(msg, 'win');
    if (App.Audio && App.Audio.sfx) { try { App.Audio.sfx('powerup'); } catch (e) {} }
    return true;
  }

  /* ---------------- Haken in coins.js ---------------- */
  /** Nächster Gewinn ×2/×3 (einmalig). coins.js ruft das bei jedem Gewinn. */
  function consumeWinBonus(delta) {
    var f = fx();
    if (f.winMult >= 2 && delta > 0) {
      var out = delta * f.winMult;
      f.winMult = 0; saveFx(f); emit(); renderChip();
      if (App.UI && App.UI.toast) App.UI.toast('✨ Gewinn ×' + (out / delta) + '!', 'win');
      return out;
    }
    return delta;
  }

  /** Rundenende (settle in coins.js). net = Netto-Ergebnis der Runde,
   *  played = ob überhaupt ein Einsatz lief. Gibt die Erstattung zurück (>=0). */
  function onRoundEnd(net, played) {
    if (!played) return 0;
    var f = fx();
    var refund = 0, why = '';
    if (net < 0) {
      if (f.freebet) { refund = -net; f.freebet = false; why = '🎰 Freispiel: Einsatz zurück'; }
      else if (f.shield > 0) { refund = -net; f.shield -= 1; why = '🛡️ Schild: Verlust erstattet'; }
      else if (goldenActive()) { refund = -net; why = '🌞 Goldene Hand: Verlust erstattet'; }
    } else if (f.freebet) {
      // Freispiel gewonnen -> verbraucht, Gewinn bleibt.
      f.freebet = false; why = '';
    }
    saveFx(f); emit(); renderChip();
    if (refund > 0 && why && App.UI && App.UI.toast) App.UI.toast(why, 'win');
    return refund;
  }

  function clearAll() { App.Storage.remove(KEY_INV); App.Storage.remove(KEY_FX); emit(); renderChip(); }

  /* ---------------- Oberfläche: Knopf in der Topnav + Sammlungs-Panel ---------------- */
  function injectCss() {
    if (!App.UI || !App.UI.injectStyle) return;
    App.UI.injectStyle('powerup-css', [
      '.pu-btn{position:relative;display:inline-flex;align-items:center;gap:5px;padding:6px 11px;border-radius:999px;',
      'border:1px solid var(--neon);background:rgba(4,16,10,.72);font-size:14px;font-weight:800;color:var(--neon);cursor:pointer;',
      'white-space:nowrap;}',
      '.pu-btn:hover{background:rgba(57,255,20,.14);}',
      '.pu-btn.fx{animation:pu-pulse 1.6s ease-in-out infinite;}',
      '@keyframes pu-pulse{0%,100%{box-shadow:0 0 4px rgba(57,255,20,.4);}50%{box-shadow:0 0 14px rgba(57,255,20,.9);}}',
      '.reduce-motion .pu-btn.fx{animation:none;}',
      '.pu-badge{min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--neon);color:#04160c;',
      'font-size:11px;font-weight:900;display:inline-flex;align-items:center;justify-content:center;}',
      '.pu-panel{display:flex;flex-direction:column;gap:14px;max-width:520px;width:100%;text-align:left;}',
      '.pu-sec-title{font-size:13px;font-weight:800;opacity:.8;margin-bottom:2px;}',
      '.pu-fx-list{display:flex;flex-wrap:wrap;gap:8px;}',
      '.pu-fx{display:inline-flex;align-items:center;gap:6px;padding:6px 11px;border-radius:999px;',
      'border:1px solid var(--neon);background:rgba(57,255,20,.1);font-size:13px;font-weight:700;}',
      '.pu-fx .pu-t{opacity:.85;font-variant-numeric:tabular-nums;}',
      '.pu-inv{display:flex;flex-direction:column;gap:8px;max-height:52vh;overflow-y:auto;}',
      '.pu-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;',
      'background:rgba(2,10,6,.55);border:1px solid var(--stroke);}',
      '.pu-item .pu-ic{font-size:26px;line-height:1;}',
      '.pu-item .pu-tx{flex:1;min-width:0;}',
      '.pu-item .pu-nm{font-weight:800;}',
      '.pu-item .pu-hint{font-size:12px;opacity:.7;}',
      '.pu-empty{opacity:.6;font-size:14px;padding:10px 0;}'
    ].join(''));
  }

  var btnEl = null, tickTimer = null;

  function activeSummaryEls() {
    var out = [];
    var el = App.UI.el;
    var l = luckActive();
    if (l) { var t = typeById(l.type); out.push(el('span', { class: 'pu-fx' }, [(t.icon || '⚡') + ' ' + t.label + ' ', el('span', { class: 'pu-t' }, [fmtRemaining(remainingMs(l.until))])])); }
    if (goldenActive()) out.push(el('span', { class: 'pu-fx' }, ['🌞 Goldene Hand ', el('span', { class: 'pu-t' }, [fmtRemaining(remainingMs(fx().golden))])]));
    var f = fx();
    if (f.freebet) out.push(el('span', { class: 'pu-fx' }, ['🎰 Freispiel scharf']));
    if (f.shield > 0) out.push(el('span', { class: 'pu-fx' }, ['🛡️ Schild ×' + f.shield]));
    if (f.winMult > 0) out.push(el('span', { class: 'pu-fx' }, ['✨ Nächster Gewinn ×' + f.winMult]));
    return out;
  }

  function openPanel() {
    injectCss();
    var el = App.UI.el;
    var body = el('div', { class: 'pu-panel' });

    function rebuild() {
      body.innerHTML = '';
      var fxEls = activeSummaryEls();
      if (fxEls.length) {
        body.appendChild(el('div', {}, [
          el('div', { class: 'pu-sec-title' }, ['Gerade aktiv']),
          el('div', { class: 'pu-fx-list' }, fxEls)
        ]));
      }
      var items = inv();
      var list = el('div', { class: 'pu-inv' });
      if (!items.length) {
        list.appendChild(el('div', { class: 'pu-empty' }, ['Noch keine Power-Ups. Gewinne ein Turnier, um welche zu sammeln! 🏆']));
      } else {
        items.forEach(function (item) {
          var t = typeById(item.type) || {};
          list.appendChild(el('div', { class: 'pu-item' }, [
            el('span', { class: 'pu-ic' }, [t.icon || '⚡']),
            el('div', { class: 'pu-tx' }, [
              el('div', { class: 'pu-nm' }, [t.label || item.type]),
              el('div', { class: 'pu-hint' }, [describe(item)])
            ]),
            el('button', {
              class: 'btn btn-primary', type: 'button',
              onclick: function () { if (useItem(item.iid)) rebuild(); }
            }, ['Benutzen'])
          ]));
        });
      }
      body.appendChild(el('div', {}, [
        el('div', { class: 'pu-sec-title' }, ['Deine Sammlung (' + items.length + ')']),
        list
      ]));
    }
    rebuild();

    var overlay = el('div', { class: 'modal-overlay' }, [
      el('div', { class: 'modal glass', style: 'max-width:560px;width:92%;' }, [
        el('h2', { class: 'neon' }, ['⚡ Power-Ups']),
        body,
        el('button', { class: 'btn btn-ghost btn-lg', type: 'button', onclick: close }, ['Schließen'])
      ])
    ]);
    function close() { if (panelTimer) { clearInterval(panelTimer); panelTimer = null; } if (overlay.parentNode) document.body.removeChild(overlay); }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
    // laufende Countdowns aktualisieren, solange offen
    var panelTimer = setInterval(rebuild, 1000);
  }

  function renderChip() {
    if (!App.UI || !App.UI.el) return;
    // Direkt neben die Coin-Anzeige (#balance) in die Kopfleiste, nicht in die
    // Icon-Navigation rechts.
    var host = document.querySelector('.topbar-right') || document.querySelector('.topnav');
    if (!host) return;
    injectCss();
    var count = inv().length;
    var show = count > 0 || anyEffectActive();

    if (!show) {
      if (btnEl && btnEl.parentNode) btnEl.parentNode.removeChild(btnEl);
      btnEl = null;
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
      return;
    }
    if (!btnEl) {
      btnEl = App.UI.el('button', { class: 'pu-btn', type: 'button', title: 'Deine Power-Ups', onclick: openPanel });
      // direkt hinter dem Guthaben einsortieren, sonst ans Ende
      var bal = document.getElementById('balance');
      if (bal && bal.parentNode === host && bal.nextSibling) host.insertBefore(btnEl, bal.nextSibling);
      else if (bal && bal.parentNode === host) host.appendChild(btnEl);
      else host.appendChild(btnEl);
    }
    btnEl.innerHTML = '';
    btnEl.appendChild(document.createTextNode('⚡'));
    var badge = App.UI.el('span', { class: 'pu-badge' }, [String(count)]);
    btnEl.appendChild(badge);
    btnEl.classList.toggle('fx', anyEffectActive());

    // Nur ticken, wenn ein zeitlicher Effekt läuft (für den Puls/Countdown-Zustand).
    var timed = luckActive() || goldenActive();
    if (timed && !tickTimer) tickTimer = setInterval(renderChip, 1000);
    if (!timed && tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  App.Powerups = {
    TYPES: TYPES,
    typeById: typeById,
    describe: describe,
    factor: factor,
    grant: grant,
    use: useItem,
    inventory: inventory,
    freebetArmed: freebetArmed,
    roundProtected: roundProtected,
    goldenActive: goldenActive,
    consumeWinBonus: consumeWinBonus,
    onRoundEnd: onRoundEnd,
    clear: clearAll,
    renderChip: renderChip,
    openPanel: openPanel,
    onChange: function (cb) {
      listeners.push(cb);
      return function () { var i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
    }
  };

  function boot() { renderChip(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
