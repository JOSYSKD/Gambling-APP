/* dragontiger.js — "Dragon Tiger" im Neon-Dschungel.
 *
 * Regeln:
 *   - Vor dem Deal wählt der Spieler EINE Wette: Drache / Tiger / Unentschieden.
 *   - Frisch gemischtes 52-Karten-Deck (Fisher-Yates), je 1 Karte an Drache & Tiger.
 *   - Nur der RANG zählt. Ass ist NIEDRIG (Ass = 1), dann 2..10, J, Q, K.
 *   - Höherer Rang gewinnt.
 * Auszahlung (brutto inkl. Einsatz):
 *   - Drache-/Tiger-Wette korrekt  → 2× Einsatz (1:1).
 *   - Tie-Wette korrekt            → 12× Einsatz (11:1).
 *   - Unentschieden bei Drache/Tiger-Wette → halber Einsatz zurück (abgerundet),
 *     der Rest ist verloren (Standard-Regel).
 */
(function () {
  'use strict';
  window.App = window.App || {};
  App.Games = App.Games || {};
  var UI = App.UI, el = UI.el;

  // Ass niedrig: Index im Array = Rangwert - 1 (A=1 ... K=13)
  var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var SUITS = ['♠', '♥', '♦', '♣'];

  function rankValue(rank) { return RANKS.indexOf(rank) + 1; } // A=1 (niedrig) ... K=13
  function isRed(suit) { return suit === '♥' || suit === '♦'; }

  function buildDeck() {
    var d = [], si, ri, i, j, t;
    for (si = 0; si < SUITS.length; si++)
      for (ri = 0; ri < RANKS.length; ri++)
        d.push({ rank: RANKS[ri], suit: SUITS[si] });
    for (i = d.length - 1; i > 0; i--) {          // Fisher-Yates
      j = Math.floor(Math.random() * (i + 1));
      t = d[i]; d[i] = d[j]; d[j] = t;
    }
    return d;
  }

  function injectCss() {
    UI.injectStyle('game-dragontiger-css', [
      '.dt-wrap{display:flex;flex-direction:column;gap:18px;}',
      '.dt-stage{gap:20px;padding:24px 16px;}',

      /* Arena */
      '.dt-arena{display:flex;align-items:stretch;justify-content:center;gap:12px;width:100%;}',
      '.dt-side{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;gap:12px;',
        'padding:16px 8px;border-radius:16px;border:1px solid var(--stroke);',
        'background:rgba(4,16,10,.5);transition:box-shadow .3s,border-color .3s,transform .3s;}',
      '.dt-side.dragon{box-shadow:inset 0 0 26px rgba(57,255,20,.12);}',
      '.dt-side.tiger{box-shadow:inset 0 0 26px rgba(255,157,60,.14);}',
      '.dt-side.win.dragon{border-color:var(--neon);box-shadow:inset 0 0 30px rgba(57,255,20,.22),0 0 22px rgba(57,255,20,.45);transform:translateY(-4px);}',
      '.dt-side.win.tiger{border-color:var(--gold);box-shadow:inset 0 0 30px rgba(255,157,60,.24),0 0 22px rgba(255,210,63,.5);transform:translateY(-4px);}',
      '.dt-side.tie{border-color:var(--aqua);box-shadow:inset 0 0 30px rgba(0,229,255,.16),0 0 18px rgba(0,229,255,.35);}',
      '.dt-side.dim{opacity:.5;}',

      '.dt-side-name{font-weight:900;letter-spacing:1px;text-transform:uppercase;font-size:15px;',
        'display:flex;align-items:center;gap:7px;}',
      '.dt-side.dragon .dt-side-name{color:var(--leaf);}',
      '.dt-side.tiger .dt-side-name{color:var(--gold);}',
      '.dt-side-emoji{font-size:20px;}',

      '.dt-rank{font-weight:900;font-variant-numeric:tabular-nums;font-size:20px;color:var(--text);',
        'min-width:40px;text-align:center;padding:3px 12px;border-radius:999px;',
        'background:rgba(4,16,10,.7);border:1px solid var(--stroke);}',
      '.dt-side.dragon .dt-rank.on{color:var(--leaf);border-color:rgba(57,255,20,.5);}',
      '.dt-side.tiger .dt-rank.on{color:var(--gold);border-color:rgba(255,210,63,.5);}',

      '.dt-vs{align-self:center;display:flex;align-items:center;justify-content:center;',
        'font-weight:900;font-size:18px;letter-spacing:1px;color:var(--muted);',
        'text-shadow:0 0 10px rgba(57,255,20,.3);}',

      /* Karte */
      '.dt-card{position:relative;width:clamp(64px,20vw,94px);height:clamp(92px,28vw,132px);border-radius:11px;',
        'background:linear-gradient(158deg,#ffffff,#e6f1ea);border:1px solid rgba(0,0,0,.28);',
        'box-shadow:0 8px 20px rgba(0,0,0,.5);color:#14202b;font-weight:800;',
        'user-select:none;-webkit-user-select:none;animation:dtDeal .34s cubic-bezier(.2,.8,.3,1.25) both;}',
      '.dt-card.red{color:#d21f3c;}',
      '.dt-card.dark{color:#14202b;}',
      '.dt-corner{position:absolute;font-size:clamp(12px,3.6vw,16px);line-height:.9;text-align:center;font-weight:900;}',
      '.dt-corner.tl{top:6px;left:7px;}',
      '.dt-corner.br{bottom:6px;right:7px;transform:rotate(180deg);}',
      '.dt-pip{position:absolute;inset:0;display:grid;place-items:center;font-size:clamp(30px,9vw,46px);}',
      '.dt-card.flip{animation:dtFlip .38s ease both;}',
      '.dt-card.back{color:var(--leaf);display:grid;place-items:center;border-color:rgba(57,255,20,.5);',
        'background:',
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40'%3E%3Cg fill='%2339ff14' opacity='0.2'%3E%3Cellipse cx='10' cy='10' rx='7' ry='3' transform='rotate(40 10 10)'/%3E%3Cellipse cx='30' cy='30' rx='7' ry='3' transform='rotate(40 30 30)'/%3E%3Cellipse cx='30' cy='8' rx='5' ry='2.4' transform='rotate(-40 30 8)'/%3E%3Cellipse cx='8' cy='30' rx='5' ry='2.4' transform='rotate(-40 8 30)'/%3E%3C/g%3E%3C/svg%3E\"),",
          'repeating-linear-gradient(45deg,rgba(57,255,20,.12) 0 7px,transparent 7px 14px),',
          'radial-gradient(circle at 50% 42%,#0e4a2c,#05271a);',
        'box-shadow:0 8px 20px rgba(0,0,0,.5),inset 0 0 0 2px rgba(57,255,20,.25);}',
      '.dt-card.back.tiger{border-color:rgba(255,210,63,.5);',
        'background:',
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40'%3E%3Cg fill='%23ffd23f' opacity='0.22'%3E%3Cellipse cx='10' cy='10' rx='7' ry='3' transform='rotate(40 10 10)'/%3E%3Cellipse cx='30' cy='30' rx='7' ry='3' transform='rotate(40 30 30)'/%3E%3Cellipse cx='30' cy='8' rx='5' ry='2.4' transform='rotate(-40 30 8)'/%3E%3Cellipse cx='8' cy='30' rx='5' ry='2.4' transform='rotate(-40 8 30)'/%3E%3C/g%3E%3C/svg%3E\"),",
          'repeating-linear-gradient(45deg,rgba(255,210,63,.12) 0 7px,transparent 7px 14px),',
          'radial-gradient(circle at 50% 42%,#4a340e,#271a05);',
        'box-shadow:0 8px 20px rgba(0,0,0,.5),inset 0 0 0 2px rgba(255,210,63,.25);}',
      '.dt-back-emoji{font-size:30px;filter:drop-shadow(0 0 7px currentColor);}',

      '@keyframes dtDeal{from{opacity:0;transform:translateY(-18px) rotate(-6deg) scale(.9);}to{opacity:1;transform:none;}}',
      '@keyframes dtFlip{0%{transform:perspective(560px) rotateY(90deg);opacity:.15;}100%{transform:perspective(560px) rotateY(0);opacity:1;}}',

      /* Banner */
      '.dt-banner{min-height:30px;font-weight:900;font-size:clamp(18px,4.8vw,26px);letter-spacing:1px;text-align:center;transition:.2s;color:var(--muted);}',
      '.dt-banner.win{color:var(--neon);text-shadow:0 0 14px rgba(57,255,20,.6);}',
      '.dt-banner.lose{color:var(--danger-2);text-shadow:0 0 12px rgba(255,77,109,.5);}',
      '.dt-banner.tie{color:var(--gold);text-shadow:0 0 16px rgba(255,210,63,.6);}',

      /* Steuerung */
      '.dt-section{display:flex;flex-direction:column;gap:12px;}',
      '.dt-section-title{text-align:center;color:var(--leaf);font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:1px;}',
      '.dt-bets{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;}',
      '.dt-betbtn{flex:1 1 120px;min-width:100px;}',
      '.dt-betbtn.dragon.active{color:#04160c;background:linear-gradient(180deg,var(--neon-soft,#8dffb0),var(--neon));border-color:var(--neon);box-shadow:var(--glow);}',
      '.dt-betbtn.tiger.active{color:#241701;background:linear-gradient(180deg,#ffd88a,var(--gold));border-color:var(--gold);box-shadow:0 0 18px rgba(255,210,63,.5);}',
      '.dt-betbtn.tie.active{color:#04121a;background:linear-gradient(180deg,#8ff0ff,var(--aqua));border-color:var(--aqua);box-shadow:0 0 18px rgba(0,229,255,.5);}',

      '.dt-info{display:flex;flex-wrap:wrap;gap:10px 22px;justify-content:center;}',
      '.dt-info-item{text-align:center;}',
      '.dt-info-l{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;}',
      '.dt-info-v{font-size:22px;font-weight:900;color:var(--leaf);font-variant-numeric:tabular-nums;}',
      '.dt-info-v.gold{color:var(--gold);}',
      '.dt-info-v.aqua{color:var(--aqua-soft,var(--aqua));}',

      '.dt-betrow{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;justify-content:center;}',
      '.dt-betrow .bet-panel{flex:1 1 240px;}',
      '.dt-deal{flex:1 1 240px;}',

      '@media (max-width:520px){.dt-card{width:clamp(58px,24vw,80px);height:clamp(84px,34vw,116px);}}',
      '@media (prefers-reduced-motion:reduce){.dt-card,.dt-card.flip{animation:none;}}'
    ].join(''));
  }

  var BETS = [
    { key: 'dragon', label: '🐲 Drache', side: 'dragon', mult: 2 },
    { key: 'tiger',  label: '🐯 Tiger',  side: 'tiger',  mult: 2 },
    { key: 'tie',    label: '🤝 Unentschieden', side: 'tie', mult: 12 }
  ];
  function betDef(key) { for (var i = 0; i < BETS.length; i++) if (BETS[i].key === key) return BETS[i]; return BETS[0]; }

  App.Games.dragontiger = {
    id: 'dragontiger',
    title: 'Dragon Tiger',
    icon: '🐲',
    subtitle: 'Eine Karte für den Drachen, eine für den Tiger — höher gewinnt',

    render: function (root) {
      injectCss();

      /* ---------- Zustand ---------- */
      var pick = 'dragon';       // gewählte Wette
      var busy = false;          // Runde läuft (keine Eingaben)
      var timers = [];
      var destroyed = false;

      function later(fn, ms) {
        var id = setTimeout(function () {
          var idx = timers.indexOf(id);
          if (idx >= 0) timers.splice(idx, 1);
          if (destroyed) return;
          fn();
        }, ms);
        timers.push(id);
        return id;
      }

      /* ---------- Arena / DOM ---------- */
      var dragonCards = el('div', {}, [el('div', { class: 'dt-card back', html: '<span class="dt-back-emoji">🐲</span>' })]);
      var tigerCards  = el('div', {}, [el('div', { class: 'dt-card back tiger', html: '<span class="dt-back-emoji">🐯</span>' })]);
      var dragonRank  = el('div', { class: 'dt-rank' }, ['—']);
      var tigerRank   = el('div', { class: 'dt-rank' }, ['—']);

      var dragonSide = el('div', { class: 'dt-side dragon' }, [
        el('div', { class: 'dt-side-name' }, [el('span', { class: 'dt-side-emoji' }, ['🐲']), 'Drache']),
        dragonCards, dragonRank
      ]);
      var tigerSide = el('div', { class: 'dt-side tiger' }, [
        el('div', { class: 'dt-side-name' }, [el('span', { class: 'dt-side-emoji' }, ['🐯']), 'Tiger']),
        tigerCards, tigerRank
      ]);

      var banner = el('div', { class: 'dt-banner' }, ['Wähle deine Wette und gib die Karten.']);

      var stage = el('div', { class: 'game-stage dt-stage' }, [
        el('div', { class: 'dt-arena' }, [
          dragonSide,
          el('div', { class: 'dt-vs' }, ['VS']),
          tigerSide
        ]),
        banner
      ]);

      /* ---------- Wett-Buttons ---------- */
      var betBtns = BETS.map(function (b) {
        return el('button', {
          class: 'btn dt-betbtn ' + b.side + (pick === b.key ? ' active' : ''),
          type: 'button',
          onclick: function () { if (!busy) selectBet(b.key); }
        }, [b.label]);
      });
      var betRow = el('div', { class: 'dt-bets' }, betBtns);

      /* ---------- Live-Info ---------- */
      var multV = el('div', { class: 'dt-info-v gold' });
      var winV  = el('div', { class: 'dt-info-v' });
      var infoRow = el('div', { class: 'dt-info' }, [
        el('div', { class: 'dt-info-item' }, [el('span', { class: 'dt-info-l' }, ['Auszahlung']), multV]),
        el('div', { class: 'dt-info-item' }, [el('span', { class: 'dt-info-l' }, ['Möglicher Gewinn']), winV])
      ]);

      var controlsPanel = el('div', { class: 'glass game-panel dt-section' }, [
        el('div', { class: 'dt-section-title' }, ['Deine Wette']),
        betRow,
        infoRow
      ]);

      /* ---------- Einsatz + Deal ---------- */
      var betPanel = UI.createBetPanel({ initial: 50, onChange: updateInfo });
      var dealBtn = el('button', {
        class: 'btn btn-primary btn-lg btn-block dt-deal', type: 'button', onclick: doDeal
      }, ['🍃 Deal']);
      var dealRow = el('div', { class: 'dt-betrow' }, [betPanel.root, dealBtn]);

      root.appendChild(el('div', { class: 'dt-wrap' }, [stage, controlsPanel, dealRow]));

      /* ---------- Karten-Rendering ---------- */
      function faceHtml(card) {
        return '<span class="dt-corner tl">' + card.rank + '<br>' + card.suit + '</span>' +
               '<span class="dt-pip">' + card.suit + '</span>' +
               '<span class="dt-corner br">' + card.rank + '<br>' + card.suit + '</span>';
      }
      function revealCard(container, card) {
        var node = el('div', { class: 'dt-card flip ' + (isRed(card.suit) ? 'red' : 'dark'), html: faceHtml(card) });
        container.innerHTML = '';
        container.appendChild(node);
      }
      function showBack(container, tiger) {
        container.innerHTML = '';
        container.appendChild(el('div', {
          class: 'dt-card back' + (tiger ? ' tiger' : ''),
          html: '<span class="dt-back-emoji">' + (tiger ? '🐯' : '🐲') + '</span>'
        }));
      }

      /* ---------- Logik ---------- */
      function selectBet(key) {
        pick = key;
        betBtns.forEach(function (b, i) { b.classList.toggle('active', BETS[i].key === key); });
        updateInfo();
      }

      function updateInfo() {
        var def = betDef(pick);
        var bet = betPanel.getBet();
        multV.textContent = def.mult + '× (' + (def.mult - 1) + ':1)';
        winV.textContent = '+' + UI.formatCoins(bet * def.mult - bet);
      }

      function setDisabled(d) {
        dealBtn.disabled = d;
        betPanel.setDisabled(d);
        betBtns.forEach(function (b) { b.disabled = d; });
      }

      function setBanner(text, cls) {
        banner.className = 'dt-banner' + (cls ? ' ' + cls : '');
        banner.textContent = text;
      }

      function doDeal() {
        if (busy) return;
        var bet = betPanel.getBet();
        if (!App.Coins.canBet(bet)) { UI.toast('Nicht genug Coins', 'lose'); return; }

        busy = true;
        setDisabled(true);
        App.Coins.add(-bet);

        var def = betDef(pick);
        var deck = buildDeck();
        var dragon = deck.pop();
        var tiger = deck.pop();

        // Reset-Optik
        dragonSide.className = 'dt-side dragon';
        tigerSide.className = 'dt-side tiger';
        dragonRank.className = 'dt-rank'; dragonRank.textContent = '—';
        tigerRank.className = 'dt-rank'; tigerRank.textContent = '—';
        showBack(dragonCards, false);
        showBack(tigerCards, true);
        setBanner('Karten werden gegeben…', null);

        // Drache aufdecken
        later(function () {
          revealCard(dragonCards, dragon);
          dragonRank.className = 'dt-rank on';
          dragonRank.textContent = dragon.rank;
          if (App.Audio) App.Audio.sfx('deal');
        }, 380);

        // Tiger aufdecken
        later(function () {
          revealCard(tigerCards, tiger);
          tigerRank.className = 'dt-rank on';
          tigerRank.textContent = tiger.rank;
          if (App.Audio) App.Audio.sfx('deal');
        }, 800);

        // Auswerten
        later(function () { resolve(bet, def, dragon, tiger); }, 1240);
      }

      function resolve(bet, def, dragon, tiger) {
        var dv = rankValue(dragon.rank), tv = rankValue(tiger.rank);
        var winnerSide = dv > tv ? 'dragon' : (tv > dv ? 'tiger' : 'tie');

        // Gewinner hervorheben
        if (winnerSide === 'dragon') dragonSide.className = 'dt-side dragon win';
        else if (winnerSide === 'tiger') tigerSide.className = 'dt-side tiger win';
        else { dragonSide.className = 'dt-side dragon tie'; tigerSide.className = 'dt-side tiger tie'; }

        var payout = 0, cls = 'lose', text = '', kind = 'lose';

        if (winnerSide === 'tie') {
          if (def.key === 'tie') {
            payout = bet * 12;
            cls = 'win'; kind = 'win';
            text = 'UNENTSCHIEDEN — Tie zahlt 11:1! 🤝';
          } else {
            // Halber Einsatz zurück bei Drache/Tiger-Wette
            payout = Math.floor(bet / 2);
            cls = 'tie'; kind = 'info';
            text = 'UNENTSCHIEDEN — halber Einsatz zurück';
          }
        } else if (def.key === winnerSide) {
          payout = bet * 2;
          cls = 'win'; kind = 'win';
          text = (winnerSide === 'dragon' ? '🐲 DRACHE' : '🐯 TIGER') + ' gewinnt!';
        } else {
          payout = 0;
          cls = 'lose'; kind = 'lose';
          text = (winnerSide === 'dragon' ? '🐲 Drache' : '🐯 Tiger') + ' gewinnt — verloren';
        }

        if (payout > 0) App.Coins.add(payout);
        var net = payout - bet;
        UI.flash(net, { label: text });
        setBanner(text, cls);
        UI.toast(text, kind);

        busy = false;
        setDisabled(false);
        betPanel.refresh();
        App.Coins.settle();
        updateInfo();
      }

      /* ---------- Init ---------- */
      updateInfo();

      return {
        cleanup: function () {
          destroyed = true;
          for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
          timers = [];
        }
      };
    }
  };
})();
