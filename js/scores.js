/* scores.js — eigene Bestenliste PRO SPIEL (App.Scores).
 *
 * Getrennt von der Gambling-Bestenliste (App.Leaderboard, bleibt wie sie ist).
 * Jedes Nicht-Gambling-Spiel bekommt so seine eigene Rangliste (bester Wert je
 * Spieler). Backend wie beim Rest: Firebase (geteilt/echtzeit) falls konfiguriert,
 * sonst lokal (localStorage) als Fallback.
 *
 * Datenmodell (Firebase): scores/<gameId>/<spielerKey> = { name, score, date }.
 *
 * API:
 *   App.Scores.setContext(gameId)         — aktuelles Spiel merken (macht minigames.js)
 *   App.Scores.submit(gameId, score[,opt]) — Wert eintragen (nur wenn besser)
 *   App.Scores.submitCurrent(score)        — für das via setContext gemerkte Spiel
 *   App.Scores.top(gameId, n, cb)          — Top-n abonnieren; cb(entries); gibt off() zurück
 *   App.Scores.showBoard(gameId[, title])  — Overlay mit der Rangliste anzeigen
 *   App.Scores.meta(gameId)                — {lower?, fmt?, label?}
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el;

  // Spiele, bei denen ein KLEINER Wert besser ist (Zeit), + optionale Formatierung.
  // win:true = Sieg-Zähler (Duelle/Poker) statt Highscore.
  var wins = function (v) { return v + (v === 1 ? ' Sieg' : ' Siege'); };
  var META = {
    reflex: { lower: true, fmt: function (v) { return v + ' ms'; }, label: 'Reaktionszeit' },
    chess: { win: true, fmt: wins, label: 'Gewonnene Partien' },
    tictactoe: { win: true, fmt: wins, label: 'Gewonnene Serien' },
    connect4: { win: true, fmt: wins, label: 'Gewonnene Partien' },
    pong: { win: true, fmt: wins, label: 'Gewonnene Matches' },
    holdem: { win: true, fmt: wins, label: 'Gewonnene Hände' },
    omaha: { win: true, fmt: wins, label: 'Gewonnene Hände' },
    stud: { win: true, fmt: wins, label: 'Gewonnene Hände' },
    fivedraw: { win: true, fmt: wins, label: 'Gewonnene Hände' },
    bingo: { win: true, fmt: wins, label: 'Bingo-Siege' },
    craps: { win: true, fmt: wins, label: 'Gewonnene Runden' },
    horserace: { win: true, fmt: wins, label: 'Gewonnene Wetten' }
  };
  function meta(id) { return META[id] || {}; }
  function fmtScore(id, v) { var m = meta(id); return m.fmt ? m.fmt(v) : (App.MG ? App.MG.fmt(v) : String(v)); }

  function sanitize(name) { return String(name || '').toLowerCase().trim().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'anon'; }
  function playerName() { return (App.Leaderboard && App.Leaderboard.getPlayerName()) || 'Spieler'; }
  function today() { try { return new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch (e) { return ''; } }

  var _ctx = null;
  var _fb = null;
  function useFirebase() { return !!(App.Net && App.Net.firebaseConfigured()); }
  function dbReady() { if (_fb) return Promise.resolve(_fb); return App.Net.firebaseDb().then(function (db) { _fb = db; return db; }); }

  function localAll() { return App.Storage ? App.Storage.get('gj_scores', {}) : {}; }
  function localSet(all) { if (App.Storage) App.Storage.set('gj_scores', all); }

  function sortEntries(obj, lower, n) {
    var arr = Object.keys(obj || {}).map(function (k) { return obj[k]; }).filter(function (e) { return e && typeof e.score === 'number'; });
    arr.sort(function (a, b) { return lower ? a.score - b.score : b.score - a.score; });
    return arr.slice(0, n || 10);
  }

  function submit(gameId, score, opt) {
    if (!gameId) return;
    opt = opt || {};
    score = Math.round(Number(score) || 0);
    var lower = opt.lower != null ? opt.lower : !!meta(gameId).lower;
    var key = sanitize(playerName());
    var entry = { name: playerName().slice(0, 18), score: score, date: today() };
    function better(cur) { return !cur || typeof cur.score !== 'number' || (lower ? score < cur.score : score > cur.score); }
    if (useFirebase()) {
      dbReady().then(function (db) {
        var ref = db.ref('scores/' + gameId + '/' + key);
        ref.get().then(function (s) { if (better(s.val())) ref.set(entry); }).catch(function () { ref.set(entry); });
      }).catch(function () { localSubmit(gameId, key, entry, better); });
    } else localSubmit(gameId, key, entry, better);
  }
  function localSubmit(gameId, key, entry, better) {
    var all = localAll(), g = all[gameId] || {};
    if (better(g[key])) { g[key] = entry; all[gameId] = g; localSet(all); }
  }
  function submitCurrent(score) { if (_ctx) submit(_ctx, score); }

  // Sieg zählen (für Duelle/Poker): Wert = Gesamtzahl der Siege dieses Spielers.
  function submitWin(gameId) {
    if (!gameId) return;
    var key = sanitize(playerName());
    function bump(cur) { return { name: playerName().slice(0, 18), score: ((cur && cur.score) || 0) + 1, date: today() }; }
    if (useFirebase()) {
      dbReady().then(function (db) {
        var ref = db.ref('scores/' + gameId + '/' + key);
        ref.get().then(function (s) { ref.set(bump(s.val())); }).catch(function () { ref.set(bump(null)); });
      }).catch(function () { var all = localAll(), g = all[gameId] || {}; g[key] = bump(g[key]); all[gameId] = g; localSet(all); });
    } else { var all = localAll(), g = all[gameId] || {}; g[key] = bump(g[key]); all[gameId] = g; localSet(all); }
  }
  function winCurrent() { if (_ctx) submitWin(_ctx); }

  function top(gameId, n, cb) {
    var lower = !!meta(gameId).lower;
    if (useFirebase()) {
      var off = function () {};
      dbReady().then(function (db) {
        var ref = db.ref('scores/' + gameId);
        var h = ref.on('value',
          function (s) { cb(sortEntries(s.val(), lower, n)); },
          function () { cb(sortEntries(localAll()[gameId], lower, n)); }); // Fehler (z. B. Regeln) -> lokal
        off = function () { try { ref.off('value', h); } catch (e) {} };
      }).catch(function () { cb(sortEntries(localAll()[gameId], lower, n)); });
      return function () { off(); };
    }
    cb(sortEntries(localAll()[gameId], lower, n));
    return function () {};
  }

  /* ---------- Overlay-Ansicht ---------- */
  function gameTitle(gameId) {
    if (App.Minigames && App.Minigames[gameId]) return App.Minigames[gameId].title;
    return gameId;
  }
  function gameIcon(gameId) {
    if (App.Minigames && App.Minigames[gameId]) return App.Minigames[gameId].icon || '🎮';
    return '🏆';
  }
  function showBoard(gameId, title) {
    injectCss();
    var list = el('div', { class: 'sc-list' }, [el('p', { class: 'hint-text' }, ['Lade …'])]);
    var off = null;
    var overlay = el('div', { class: 'sc-overlay' }, [
      el('div', { class: 'sc-card glass' }, [
        el('button', { class: 'sc-close', type: 'button', title: 'Schließen', onclick: close }, ['✕']),
        el('div', { class: 'sc-head' }, [
          el('div', { class: 'sc-icon' }, [gameIcon(gameId)]),
          el('h2', { class: 'neon' }, [(title || gameTitle(gameId))]),
          el('p', { class: 'hint-text' }, [meta(gameId).label || 'Bestenliste – bester Wert pro Spieler'])
        ]),
        list
      ])
    ]);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
    off = top(gameId, 15, function (entries) { renderRows(list, gameId, entries); });
    function close() { if (off) off(); if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
  }
  function renderRows(list, gameId, entries) {
    list.innerHTML = '';
    if (!entries || !entries.length) { list.appendChild(el('p', { class: 'hint-text' }, ['Noch keine Einträge – spiel eine Runde!'])); return; }
    var me = sanitize(playerName());
    entries.forEach(function (e, i) {
      var rank = i + 1;
      list.appendChild(el('div', { class: 'sc-row' + (i < 3 ? ' sc-top' + rank : '') + (sanitize(e.name) === me ? ' me' : '') }, [
        el('span', { class: 'sc-rank' }, [rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : ('#' + rank)]),
        el('span', { class: 'sc-name' }, [e.name || 'Anonym']),
        el('span', { class: 'sc-score' }, [fmtScore(gameId, e.score)])
      ]));
    });
  }

  function injectCss() {
    UI.injectStyle('scores-css', [
      '.sc-overlay{position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;background:rgba(2,10,6,.72);backdrop-filter:blur(4px);padding:16px;animation:sc-fade .18s ease;}',
      '@keyframes sc-fade{from{opacity:0}to{opacity:1}}',
      '.sc-card{position:relative;width:100%;max-width:440px;max-height:82vh;overflow:auto;padding:22px;display:flex;flex-direction:column;gap:12px;}',
      '.sc-close{position:absolute;top:10px;right:12px;background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;}',
      '.sc-close:hover{color:var(--text);}',
      '.sc-head{text-align:center;display:flex;flex-direction:column;gap:2px;align-items:center;}',
      '.sc-icon{font-size:40px;line-height:1;}',
      '.sc-head h2{margin:2px 0 0;}',
      '.sc-list{display:flex;flex-direction:column;gap:6px;}',
      '.sc-row{display:grid;grid-template-columns:44px 1fr auto;align-items:center;gap:10px;padding:9px 12px;border-radius:12px;background:rgba(9,32,21,.6);border:1px solid var(--stroke);}',
      '.sc-row.me{border-color:var(--neon);box-shadow:0 0 0 1px rgba(57,255,20,.4);}',
      '.sc-row.sc-top1{background:linear-gradient(90deg,rgba(255,210,63,.18),rgba(9,32,21,.6));}',
      '.sc-rank{font-size:18px;font-weight:900;text-align:center;color:var(--leaf);}',
      '.sc-name{font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.sc-score{font-weight:900;color:var(--gold);font-variant-numeric:tabular-nums;}'
    ].join(''));
  }

  App.Scores = {
    setContext: function (id) { _ctx = id; },
    submit: submit, submitCurrent: submitCurrent, submitWin: submitWin, winCurrent: winCurrent,
    top: top, showBoard: showBoard, meta: meta
  };
})();
