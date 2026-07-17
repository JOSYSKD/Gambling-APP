/* ideas.js — Spielideen-Briefkasten (App.Ideas).
 *
 * Jeder Spieler kann oben in der Leiste über den 💡-Knopf eine Spielidee
 * eintippen. Die Idee wird als Nachricht an den Admin geschickt und taucht im
 * Admin-Panel (js/admin.js) in der Liste „Spielideen" auf, wo der Admin sie
 * abhaken oder löschen kann.
 *
 * BELOHNUNG: Der Admin kann eine Idee mit einem Faktor (×5/×10/×20/×30)
 * annehmen. Ausgezahlt wird `Faktor × Einstiegsguthaben des Spielers` — einmalig,
 * in Casino-Silber. Der Admin legt nur den Faktor fest; die Summe rechnet der
 * Client des Spielers beim Abholen aus seinem AKTUELLEN Einstiegsguthaben aus
 * (App.Progress.startBalanceIn('casino')), so wie es der Host verlangt hat.
 * Der Admin sieht dafür den beim Einreichen gespeicherten Stand als Vorschau.
 *
 * IDEEN-LEVEL: Jede belohnte Idee zählt als „erfolgreiche Idee". Daraus ergibt
 * sich ein eigenes Ideen-Level 1–5 (5 = MAX bei 20 erfolgreichen Ideen), das die
 * goldenen Glühbirnen auf der Profilkarte steuert (siehe js/profile-card.js).
 *
 * Speicherort: der bereits offene, in Firebase veröffentlichte Knoten `scores`
 * (Unterschlüssel `scores/__ideas`) — genau wie survival.js seinen Board dort
 * ablegt. So braucht dieses Feature KEINEN neuen Firebase-Regel-Deploy (ein
 * eigener `ideas`-Knoten wäre per Default gesperrt und müsste erst publiziert
 * werden). scores.js liest nur `scores/<spielId>`; der doppelte Unterstrich in
 * `__ideas` kollidiert also mit keiner Spiel-Bestenliste.
 *
 * Ohne Firebase (file:// / nur lokal) läuft alles über den lokalen Fallback-
 * Speicher von App.Net.store() — dann sieht der Admin nur die Ideen desselben
 * Geräts, was für einen Offline-Test genügt.
 */
(function () {
  'use strict';
  window.App = window.App || {};

  var PATH = 'scores/__ideas';
  var MAX_LEN = 10000;

  /* Auswählbare Belohnungs-Faktoren des Hosts (Vielfaches des Einstiegsguthabens). */
  var MULTS = [5, 10, 20, 30];

  /* Ideen-Level: erfolgreiche Ideen -> Level 1..5. Level 5 = MAX (20 Ideen). */
  var MAX_IDEA_LEVEL = 5;
  var LEVEL_AT = [1, 3, 7, 12, 20];      // ab wie vielen erfolgreichen Ideen Level 1,2,3,4,5

  var KEY_WINS = 'gj_idea_wins';         // Anzahl belohnter eigener Ideen (Cache fürs Level)
  var KEY_PAID = 'gj_idea_paid';         // bereits ausgezahlte Belohnungs-Ids (Doppelzahl-Schutz)

  function store() { return App.Net.store(); }

  function deviceId() { return App.Storage.get('gj_device_id', null) || 'anon'; }
  function accountKey() {
    return (App.Account && App.Account.isLoggedIn && App.Account.isLoggedIn() && App.Account.currentKey)
      ? App.Account.currentKey() : null;
  }
  function myName() {
    return (App.Leaderboard && App.Leaderboard.getPlayerName && App.Leaderboard.getPlayerName()) || 'Gast';
  }
  function newId() { return 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /** Einstiegsguthaben (Casino-Silber) — Basis jeder Ideen-Belohnung. */
  function startBal() {
    if (App.Progress && App.Progress.startBalanceIn) return App.Progress.startBalanceIn('casino');
    if (App.Progress && App.Progress.startBalance) return App.Progress.startBalance();
    return 1000;
  }

  /** Eine Spielidee an den Admin schicken. Gibt ein Promise zurück. */
  function submit(text) {
    text = String(text || '').trim().slice(0, MAX_LEN);
    if (!text) return Promise.reject(new Error('leer'));
    var id = newId();
    var idea = {
      id: id, name: myName(), pid: deviceId(), text: text, at: Date.now(), done: false,
      akey: accountKey(),      // damit die Belohnung auch auf einem zweiten Gerät ankommt
      startBal: startBal()     // Vorschau-Wert fürs Admin-Panel (ausgezahlt wird der aktuelle Stand)
    };
    var patch = {}; patch[id] = idea;
    return store().then(function (b) { return b.update(PATH, patch); }).then(function () { return idea; });
  }

  /** Alle Ideen lesen (neueste zuerst). Für das Admin-Panel. */
  function list() {
    return store().then(function (b) { return b.get(PATH); }).then(function (o) {
      o = o || {};
      return Object.keys(o).map(function (k) { return Object.assign({ id: k }, o[k]); })
        .sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    }).catch(function () { return []; });
  }

  function remove(id) { return store().then(function (b) { return b.remove(PATH + '/' + id); }); }
  function setDone(id, done) { return store().then(function (b) { return b.update(PATH + '/' + id, { done: !!done }); }); }

  /* ---------------- Belohnung (nur Admin) ---------------- */

  /** Idee annehmen und belohnen: Faktor auf das Einstiegsguthaben (5/10/20/30).
   *  Die Auszahlung selbst macht der Client des Spielers beim nächsten Abholen. */
  function setReward(id, mult) {
    mult = Math.round(Number(mult) || 0);
    if (MULTS.indexOf(mult) < 0) return Promise.reject(new Error('Ungültiger Faktor'));
    var reward = { rid: newId(), mult: mult, at: Date.now() };
    return store().then(function (b) { return b.update(PATH + '/' + id, { reward: reward, done: true }); });
  }

  /** Belohnung wieder zurücknehmen (nur solange sie noch nicht abgeholt wurde). */
  function clearReward(id) {
    return store().then(function (b) { return b.update(PATH + '/' + id, { reward: null, paid: null, claimedAt: null }); });
  }

  /* ---------------- Auszahlung + Ideen-Level (Spieler-Seite) ---------------- */

  function isMine(idea) {
    var k = accountKey();
    if (k && idea.akey && idea.akey === k) return true;
    return !!(idea.pid && idea.pid === deviceId());
  }
  function paidIds() {
    var a = App.Storage.get(KEY_PAID, null);
    return Object.prototype.toString.call(a) === '[object Array]' ? a : [];
  }
  function markPaid(rid) {
    var a = paidIds();
    if (a.indexOf(rid) < 0) { a.push(rid); App.Storage.set(KEY_PAID, a.slice(-200)); }
  }

  /** Belohnung gutschreiben — IMMER auf den Casino-Stand (Silber), egal welcher
   *  Modus gerade läuft (gleiche Mechanik wie App.Survival.applyGoldGrant). */
  function payout(amount) {
    if (!App.Mode) { if (App.Coins) App.Coins.add(amount); return; }
    var bal = Number(App.Mode.readIn('casino', 'gj_balance', 0)) || 0;
    var next = bal + amount;
    App.Mode.writeIn('casino', 'gj_balance', next);
    var peak = Number(App.Mode.readIn('casino', 'gj_run_peak', 0)) || 0;
    if (next > peak) App.Mode.writeIn('casino', 'gj_run_peak', next);
    if (App.Mode.is('casino')) App.Mode.refresh();   // läuft gerade Casino -> sofort sichtbar
  }

  function celebrate(idea, amount) {
    var lv = level();
    if (App.UI && App.UI.toast) {
      App.UI.toast('💡 Deine Idee wurde angenommen! +' + App.UI.formatCoins(amount) + ' 🪙 (×' + idea.reward.mult + ')', 'win');
    }
    if (App.Audio && App.Audio.sfx) { try { App.Audio.sfx('powerup'); } catch (e) {} }
    showRewardModal(idea, amount, lv);
  }

  /** Ist die Belohnung dieser Idee bei mir schon angekommen? `claimedAt`/`paid`
   *  stehen im geteilten Datensatz — daher zahlt auch ein ZWEITES Gerät desselben
   *  Kontos nicht noch einmal aus (dessen lokale rid-Liste ist ja leer). */
  function isCollected(idea, seen) {
    if (!idea.reward || !idea.reward.rid) return false;
    return !!idea.claimedAt || !!idea.paid || seen.indexOf(idea.reward.rid) >= 0;
  }

  /** Alle eigenen Ideen prüfen: belohnte auszahlen, Ideen-Level nachziehen. */
  function checkRewards() {
    return list().then(function (all) {
      var mine = all.filter(isMine);
      var seen = paidIds();
      var pending = mine.filter(function (idea) {
        return idea.reward && idea.reward.rid && !isCollected(idea, seen);
      });

      var payouts = [];
      pending.forEach(function (idea) {
        markPaid(idea.reward.rid);                     // zuerst sperren -> keine Doppelzahlung
        var amount = Math.max(0, Math.round(startBal() * idea.reward.mult));
        if (!amount) return;
        payout(amount);
        // Für den Admin (und andere Geräte) sichtbar machen, dass sie angekommen ist.
        store().then(function (b) {
          return b.update(PATH + '/' + idea.id, { claimedAt: Date.now(), paid: amount });
        }).catch(function () {});
        payouts.push({ idea: idea, amount: amount });
      });

      /* Zähler der erfolgreichen Ideen — er WÄCHST NUR: eine einmal verdiente
       * Glühbirne bleibt für immer, auch wenn der Host die Idee später löscht oder
       * die Belohnung zurücknimmt.
       *   (a) jede FRISCHE Auszahlung zählt +1 — unabhängig davon, was noch auf dem
       *       Server liegt (sonst könnte eine neue Idee den Zähler nicht mehr heben,
       *       nachdem der Host ältere belohnte Ideen gelöscht hat);
       *   (b) zusätzlich auf die Zahl der belegten Datensätze anheben — so heilt sich
       *       ein Storage-Verlust aus `claimedAt`/`paid`, solange die Ideen noch da sind.
       * Beides über Math.max, damit ein zweiter Lauf mit denselben Daten nicht doppelt zählt. */
      var got = paidIds();
      var earned = 0;
      mine.forEach(function (idea) { if (isCollected(idea, got)) earned++; });
      App.Storage.set(KEY_WINS, Math.max(winCount() + payouts.length, earned));

      // Erst NACH dem Zähler feiern — das Feier-Fenster zeigt das neue Ideen-Level.
      payouts.forEach(function (p) { celebrate(p.idea, p.amount); });
      return { wins: winCount(), paid: payouts.length };
    }).catch(function () { return { wins: winCount(), paid: 0 }; });
  }

  function winCount() { return Math.max(0, Math.round(Number(App.Storage.get(KEY_WINS, 0)) || 0)); }

  /** Ideen-Level 0–5 aus der Anzahl erfolgreicher Ideen. */
  function levelFor(n) {
    var lv = 0;
    for (var i = 0; i < LEVEL_AT.length; i++) if (n >= LEVEL_AT[i]) lv = i + 1;
    return lv;
  }
  function level() { return levelFor(winCount()); }
  function isMaxLevel() { return level() >= MAX_IDEA_LEVEL; }
  /** Ab wie vielen erfolgreichen Ideen kommt das nächste Level? null = schon MAX. */
  function nextAt() {
    var lv = level();
    return lv >= MAX_IDEA_LEVEL ? null : LEVEL_AT[lv];
  }

  /* ---------------- Oberfläche: 💡-Knopf in der Topnav + Eingabe-Panel ---------------- */
  function injectCss() {
    if (!App.UI || !App.UI.injectStyle) return;
    App.UI.injectStyle('idea-css', [
      '.idea-btn{cursor:pointer;color:inherit;background:rgba(6,26,17,0.6);}',
      '.idea-panel{display:flex;flex-direction:column;gap:12px;max-width:520px;width:100%;text-align:left;}',
      '.idea-intro{opacity:.82;font-size:14px;margin:0;}',
      '.idea-ta{width:100%;box-sizing:border-box;resize:vertical;min-height:120px;font-size:15px;padding:12px 14px;',
      'border-radius:12px;border:1px solid var(--stroke);background:rgba(2,10,6,.6);color:#eaffe2;font-family:inherit;line-height:1.4;}',
      '.idea-ta:focus{outline:none;border-color:var(--neon);box-shadow:0 0 10px rgba(57,255,20,.4);}',
      '.idea-count{font-size:12px;opacity:.6;text-align:right;margin-top:-4px;}',
      // Ideen-Level im Panel
      '.idea-lvbox{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:14px;',
      'background:rgba(255,210,63,.08);border:1px solid rgba(255,210,63,.35);text-align:left;}',
      '.idea-lvbulbs{font-size:20px;line-height:1;letter-spacing:-2px;white-space:nowrap;',
      'filter:drop-shadow(0 0 6px rgba(255,210,63,.85));}',
      '.idea-lvbulbs .off{filter:grayscale(1);opacity:.28;}',
      '.idea-lvtxt{flex:1;min-width:0;}',
      '.idea-lvtitle{font-weight:900;color:var(--gold);font-size:14px;}',
      '.idea-lvsub{font-size:12px;color:var(--muted);}',
      // Eigene Ideen (Status-Liste)
      '.idea-my{display:flex;flex-direction:column;gap:6px;max-height:150px;overflow-y:auto;}',
      '.idea-my-row{display:flex;gap:8px;align-items:baseline;padding:7px 10px;border-radius:10px;',
      'background:rgba(2,10,6,.5);border:1px solid var(--stroke);font-size:13px;}',
      '.idea-my-txt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.idea-my-st{font-weight:800;font-size:12px;color:var(--muted);white-space:nowrap;}',
      '.idea-my-st.win{color:var(--gold);}',
      // Belohnungs-Feier
      '.idea-win-sum{font-size:34px;font-weight:900;color:var(--gold);text-shadow:0 0 18px rgba(255,210,63,.6);}',
      '.idea-win-mult{font-size:14px;color:var(--muted);}',
      '.idea-win-quote{font-style:italic;opacity:.8;font-size:13px;max-height:80px;overflow:auto;',
      'border-left:3px solid var(--gold);padding-left:10px;text-align:left;}'
    ].join(''));
  }

  /** Glühbirnen-Reihe: `lv` volle goldene + Rest ausgegraut (bis MAX_IDEA_LEVEL). */
  function bulbRow(lv) {
    var kids = [];
    for (var i = 1; i <= MAX_IDEA_LEVEL; i++) {
      kids.push(App.UI.el('span', i <= lv ? {} : { class: 'off' }, ['💡']));
    }
    return App.UI.el('span', { class: 'idea-lvbulbs' }, kids);
  }

  /** Feier-Fenster, wenn eine Idee belohnt wurde. */
  function showRewardModal(idea, amount, lv) {
    injectCss();
    if (!App.UI || !App.UI.el) return;
    var el = App.UI.el;
    var levelUp = lv > 0 && winCount() === LEVEL_AT[lv - 1];   // genau diese Idee hat das Level gehoben
    var overlay = el('div', { class: 'modal-overlay' }, [
      el('div', { class: 'modal glass', style: 'max-width:480px;width:92%;' }, [
        el('div', { class: 'modal-leaf' }, ['💡']),
        el('h2', { class: 'neon' }, ['Idee angenommen!']),
        el('p', { class: 'idea-win-quote' }, [String(idea.text || '').slice(0, 300)]),
        el('div', { class: 'idea-win-sum' }, ['+' + App.UI.formatCoins(amount) + ' 🪙']),
        el('div', { class: 'idea-win-mult' }, ['×' + idea.reward.mult + ' dein Einstiegsguthaben · gutgeschrieben im Casino']),
        el('div', { class: 'idea-lvbox', style: 'margin-top:6px;' }, [
          bulbRow(lv),
          el('div', { class: 'idea-lvtxt' }, [
            el('div', { class: 'idea-lvtitle' }, [levelUp ? 'Ideen-Level ' + lv + ' erreicht!' : 'Ideen-Level ' + lv + (lv >= MAX_IDEA_LEVEL ? ' · MAX' : '')]),
            el('div', { class: 'idea-lvsub' }, [levelText()])
          ])
        ]),
        el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: function () { if (overlay.parentNode) document.body.removeChild(overlay); } }, ['Stark!'])
      ])
    ]);
    document.body.appendChild(overlay);
  }

  function levelText() {
    var n = winCount(), next = nextAt();
    var base = n + ' erfolgreiche Idee' + (n === 1 ? '' : 'n');
    if (next === null) return base + ' · Höchstlevel erreicht 👑';
    return base + ' · noch ' + (next - n) + ' bis Level ' + (level() + 1);
  }

  function openPanel() {
    injectCss();
    var el = App.UI.el;
    var ta = el('textarea', {
      class: 'idea-ta', rows: 5, maxlength: MAX_LEN,
      placeholder: 'Welches Spiel wünschst du dir? Beschreib deine Idee …'
    });
    var counter = el('div', { class: 'idea-count' }, ['0 / ' + MAX_LEN]);
    ta.addEventListener('input', function () { counter.textContent = ta.value.length + ' / ' + MAX_LEN; });

    var sendBtn = el('button', { class: 'btn btn-primary btn-lg', type: 'button' }, ['💡 Idee abschicken']);

    // Ideen-Level + eigene Ideen (füllt sich, sobald die Liste geladen ist)
    var lvBox = el('div', { class: 'idea-lvbox' }, [
      bulbRow(level()),
      el('div', { class: 'idea-lvtxt' }, [
        el('div', { class: 'idea-lvtitle' }, ['Ideen-Level ' + level() + (isMaxLevel() ? ' · MAX' : '')]),
        el('div', { class: 'idea-lvsub' }, [levelText()])
      ])
    ]);
    var myBox = el('div', { class: 'idea-my' });
    function refreshMy() {
      list().then(function (all) {
        var mine = all.filter(isMine);
        myBox.innerHTML = '';
        lvBox.innerHTML = '';
        lvBox.appendChild(bulbRow(level()));
        lvBox.appendChild(el('div', { class: 'idea-lvtxt' }, [
          el('div', { class: 'idea-lvtitle' }, ['Ideen-Level ' + level() + (isMaxLevel() ? ' · MAX' : '')]),
          el('div', { class: 'idea-lvsub' }, [levelText()])
        ]));
        mine.slice(0, 12).forEach(function (idea) {
          var st = idea.reward
            ? { t: '🏅 ×' + idea.reward.mult + (idea.paid ? ' · ' + App.UI.formatCoins(idea.paid) + ' 🪙' : ''), c: ' win' }
            : (idea.done ? { t: '✓ gelesen', c: '' } : { t: '⏳ wartet', c: '' });
          myBox.appendChild(el('div', { class: 'idea-my-row' }, [
            el('span', { class: 'idea-my-txt' }, [String(idea.text || '')]),
            el('span', { class: 'idea-my-st' + st.c }, [st.t])
          ]));
        });
        if (!mine.length) myBox.appendChild(el('p', { class: 'idea-intro' }, ['Noch keine Idee von dir eingereicht.']));
      }).catch(function () {});
    }

    var overlay = el('div', { class: 'modal-overlay' }, [
      el('div', { class: 'modal glass', style: 'max-width:540px;width:92%;' }, [
        el('div', { class: 'modal-leaf' }, ['💡']),
        el('h2', { class: 'neon' }, ['Spielidee vorschlagen']),
        el('p', { class: 'idea-intro' }, ['Schreib dem Admin, welches Spiel du dir wünschst oder was verbessert werden soll. Nimmt er deine Idee an, bekommst du ein Vielfaches deines Einstiegsguthabens als Belohnung — und eine goldene Glühbirne auf der Profilkarte.']),
        el('div', { class: 'idea-panel' }, [lvBox, ta, counter, myBox]),
        sendBtn,
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: close }, ['Schließen'])
      ])
    ]);
    function close() { if (overlay.parentNode) document.body.removeChild(overlay); }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    sendBtn.addEventListener('click', function () {
      var text = ta.value.trim();
      if (!text) {
        ta.focus();
        if (App.UI.toast) App.UI.toast('Bitte schreib zuerst deine Idee.', 'lose');
        return;
      }
      sendBtn.disabled = true;
      submit(text).then(function () {
        if (App.UI.toast) App.UI.toast('💡 Danke! Deine Idee ging an den Admin.', 'win');
        if (App.Audio && App.Audio.sfx) { try { App.Audio.sfx('powerup'); } catch (e) {} }
        // Offen lassen: der Spieler sieht seine Idee sofort unten mit Status „wartet".
        ta.value = ''; counter.textContent = '0 / ' + MAX_LEN;
        sendBtn.disabled = false;
        refreshMy();
      }).catch(function () {
        sendBtn.disabled = false;
        if (App.UI.toast) App.UI.toast('Konnte gerade nicht senden — bitte nochmal versuchen.', 'lose');
      });
    });
    document.body.appendChild(overlay);
    refreshMy();
    setTimeout(function () { ta.focus(); }, 50);
  }

  var placed = false;
  function renderChip() {
    if (placed) return;
    var nav = document.querySelector('.topnav');
    if (!nav || !App.UI || !App.UI.el) return;
    injectCss();
    var btn = App.UI.el('button', {
      class: 'topnav-link idea-btn', type: 'button',
      title: 'Spielidee an den Admin schicken', onclick: openPanel
    }, ['💡']);
    nav.insertBefore(btn, nav.firstChild);   // ganz vorne in der Leiste
    placed = true;
  }

  App.Ideas = {
    submit: submit,
    list: list,
    remove: remove,
    setDone: setDone,
    openPanel: openPanel,
    renderChip: renderChip,
    PATH: PATH,

    /* Belohnung (Admin-Panel, siehe js/admin.js) */
    MULTS: MULTS,
    setReward: setReward,
    clearReward: clearReward,

    /* Ideen-Level (Profilkarte, siehe js/profile-card.js) */
    MAX_LEVEL: MAX_IDEA_LEVEL,
    LEVEL_AT: LEVEL_AT.slice(),
    level: level,
    levelForWins: levelFor,
    isMaxLevel: isMaxLevel,
    wins: winCount,
    nextAt: nextAt,
    levelText: levelText,
    checkRewards: checkRewards
  };

  // Belohnungen abholen: beim Start und danach regelmäßig (der Admin kann eine
  // Idee jederzeit annehmen, während der Spieler online ist).
  var POLL_MS = 30000;
  function boot() {
    renderChip();
    checkRewards();
    setInterval(checkRewards, POLL_MS);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
