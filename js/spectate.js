/* spectate.js — Echtes Live-Bildschirm-Teilen: Mods/Admin sehen 1:1 den Bildschirm
 * eines Spielers (wie echtes Screen-Sharing), nicht mehr nur eine Status-Nachbildung.
 *
 * Technik: WebRTC (getDisplayMedia + RTCPeerConnection, STUN) mit Firebase Realtime
 * DB als Signaling-Kanal unter spectate/<geräte-id>. Aus Browser-Sicherheitsgründen
 * MUSS der beobachtete Spieler aktiv zustimmen — getDisplayMedia zeigt einen nativen
 * Dialog. Heimliches Teilen ist technisch unmöglich; darum gibt es einen Zustimmungs-
 * Flow (Modal beim Spieler).
 *
 * Rollen im Signaling (spectate/<zielId>/…):
 *   - Spieler (Anbieter, „callee"): erstellt getDisplayMedia + Offer.
 *       schreibt: offer, ice_callee, declined      lauscht: answer, ice_caller
 *   - Zuschauer/Mod („caller"): erstellt Answer.
 *       schreibt: req, answer, ice_caller           lauscht: offer, ice_callee, declined
 *
 * Aufräumen: Session-Knoten werden am Ende immer entfernt (ref.remove()); zusätzlich
 * onDisconnect().remove() als Netz gegen abstürzende Tabs. Der Zuschauer räumt SEINEN
 * onDisconnect wieder ab (cancel), da der Knoten dem Spieler „gehört".
 */
(function () {
  'use strict';
  window.App = window.App || {};
  var UI = App.UI, el = UI.el;

  var RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  var ANSWER_TIMEOUT_MS = 30000;

  function fbReady() { return !!(App.Net && App.Net.firebaseConfigured && App.Net.firebaseConfigured()); }
  function myKey() { return (App.Presence && App.Presence.deviceId) ? App.Presence.deviceId() : null; }
  function myName() { return (App.Leaderboard && App.Leaderboard.getPlayerName && App.Leaderboard.getPlayerName()) || 'Mod'; }
  function hasRtc() { return typeof window.RTCPeerConnection === 'function'; }
  function canShare() { return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia); }

  /* Puffert eingehende ICE-Candidates, bis eine RemoteDescription gesetzt ist —
   * sonst wirft addIceCandidate. Nach setReady() werden gepufferte nachgereicht. */
  function makeIceApplier(pc) {
    var buffer = [], ready = false;
    function apply(c) { try { pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {} }
    return {
      setReady: function () { ready = true; buffer.forEach(apply); buffer = []; },
      add: function (c) { if (!c) return; if (ready) apply(c); else buffer.push(c); }
    };
  }

  function injectCss() {
    UI.injectStyle('spectate-css', [
      // Zuschauer-Overlay (Video-„TV")
      '.spec-overlay{position:fixed;inset:0;z-index:120;background:rgba(2,8,5,.86);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:16px;}',
      '.spec-tv{width:min(880px,96vw);border-radius:18px;overflow:hidden;border:1px solid var(--stroke-2);box-shadow:0 20px 60px rgba(0,0,0,.6);background:linear-gradient(180deg,#06170e,#03100a);display:flex;flex-direction:column;max-height:92vh;}',
      '.spec-bar{display:flex;align-items:center;gap:10px;padding:12px 16px;background:rgba(0,0,0,.35);border-bottom:1px solid var(--stroke);flex:0 0 auto;}',
      '.spec-live{font-size:11px;font-weight:900;color:#fff;background:var(--danger-2,#ff4d6d);padding:2px 8px;border-radius:99px;box-shadow:0 0 10px rgba(255,77,109,.6);}',
      '.spec-live.wait{background:var(--muted,#7c8a80);box-shadow:none;}',
      '.spec-who{font-weight:900;color:#eaffe2;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.spec-close{cursor:pointer;background:none;border:0;color:var(--muted);font-size:22px;line-height:1;padding:0 4px;}',
      '.spec-stage{position:relative;background:#000;min-height:200px;display:flex;align-items:center;justify-content:center;}',
      '.spec-video{width:100%;max-height:78vh;display:block;background:#000;object-fit:contain;}',
      '.spec-status{position:absolute;inset:0;display:flex;flex-direction:column;gap:14px;align-items:center;justify-content:center;text-align:center;padding:24px;color:#dfeede;background:rgba(3,16,10,.72);}',
      '.spec-spin{width:34px;height:34px;border-radius:50%;border:3px solid rgba(255,255,255,.18);border-top-color:var(--neon,#39ff14);animation:spec-rot 1s linear infinite;}',
      '@keyframes spec-rot{to{transform:rotate(360deg);}}',
      '.spec-status-t{font-weight:800;font-size:15px;line-height:1.4;max-width:340px;}',
      // Zustimmungs-Modal (beim Spieler)
      '.spec-ask{position:fixed;inset:0;z-index:130;background:rgba(2,8,5,.82);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:18px;}',
      '.spec-ask-card{width:min(420px,94vw);border-radius:18px;padding:24px 22px;text-align:center;display:flex;flex-direction:column;gap:16px;background:linear-gradient(180deg,#071a0f,#04120b);border:1px solid var(--stroke-2);box-shadow:0 22px 60px rgba(0,0,0,.6);}',
      '.spec-ask-ico{font-size:40px;line-height:1;}',
      '.spec-ask-title{font-weight:900;font-size:18px;color:#eaffe2;line-height:1.35;}',
      '.spec-ask-sub{font-size:12.5px;color:var(--muted);line-height:1.5;}',
      '.spec-ask-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;}'
    ].join(''));
  }

  /* =========================================================================
   *  SPIELER-SEITE — auf Watch-Anfragen lauschen und (nach Zustimmung) teilen
   * ========================================================================= */
  var reqListening = false;
  var activeShare = null;   // { pc, stream, baseRef, answerRef, iceRef }
  var askOpen = false;

  function teardownShare() {
    var s = activeShare; activeShare = null;
    if (!s) return;
    try { s.answerRef && s.answerRef.off(); } catch (e) {}
    try { s.iceRef && s.iceRef.off(); } catch (e) {}
    try { s.stream && s.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { s.pc && s.pc.close(); } catch (e) {}
    // Der Knoten gehört dem Spieler selbst -> einfach leeren (onDisconnect bleibt als Netz).
    try { s.baseRef && s.baseRef.remove(); } catch (e) {}
  }

  function startSharing(db, targetId) {
    if (!canShare()) {
      UI.toast('Bildschirm teilen wird hier nicht unterstützt.', 'lose');
      try { db.ref('spectate/' + targetId + '/declined').set({ ts: Date.now() }); } catch (e) {}
      return;
    }
    teardownShare();
    navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }).then(function (stream) {
      var baseRef = db.ref('spectate/' + targetId);
      var pc = new RTCPeerConnection(RTC_CONFIG);
      var iceRef = baseRef.child('ice_caller');       // Zuschauer-Candidates
      var answerRef = baseRef.child('answer');
      var applier = makeIceApplier(pc);
      activeShare = { pc: pc, stream: stream, baseRef: baseRef, answerRef: answerRef, iceRef: iceRef };

      // Netz gegen abstürzenden Tab: eigener Knoten wird bei Disconnect entfernt.
      try { baseRef.onDisconnect().remove(); } catch (e) {}

      stream.getTracks().forEach(function (t) {
        pc.addTrack(t, stream);
        // Nutzer beendet das Teilen über die Browser-Leiste -> aufräumen.
        t.addEventListener('ended', function () { teardownShare(); });
      });

      pc.onicecandidate = function (e) {
        if (e.candidate) { try { baseRef.child('ice_callee').push(e.candidate.toJSON()); } catch (err) {} }
      };
      pc.onconnectionstatechange = function () {
        var st = pc.connectionState;
        if (st === 'failed' || st === 'closed' || st === 'disconnected') teardownShare();
      };

      // Auf Answer des Zuschauers warten.
      answerRef.on('value', function (snap) {
        var a = snap.val();
        if (!a || !a.sdp || pc.currentRemoteDescription) return;
        pc.setRemoteDescription(new RTCSessionDescription(a))
          .then(function () { applier.setReady(); })
          .catch(function () {});
      });
      // Zuschauer-ICE einsammeln (gepuffert bis RemoteDescription steht).
      iceRef.on('child_added', function (snap) { applier.add(snap.val()); });

      // Offer erstellen und schreiben.
      pc.createOffer().then(function (offer) {
        return pc.setLocalDescription(offer).then(function () {
          baseRef.child('offer').set({ type: offer.type, sdp: offer.sdp });
        });
      }).catch(function () { teardownShare(); });

      UI.toast('📺 Du teilst jetzt deinen Bildschirm.', 'win');
    }).catch(function () {
      // Nutzer hat den getDisplayMedia-Dialog abgebrochen o. Ä.
      try { db.ref('spectate/' + targetId + '/declined').set({ ts: Date.now() }); } catch (e) {}
      teardownShare();
    });
  }

  function showConsent(db, fromName) {
    if (askOpen || activeShare) return;
    askOpen = true;
    injectCss();
    var targetId = myKey();

    var card = el('div', { class: 'spec-ask-card' }, [
      el('div', { class: 'spec-ask-ico' }, ['🛡']),
      el('div', { class: 'spec-ask-title' }, [(fromName || 'Ein Mod') + ' möchte deinen Bildschirm sehen.']),
      el('div', { class: 'spec-ask-sub' }, ['Wenn du zustimmst, fragt dein Browser als Nächstes, welchen Bildschirm oder Tab du teilen willst. Du kannst das Teilen jederzeit wieder beenden.'])
    ]);
    var modal = el('div', { class: 'spec-ask' }, [card]);

    function done() { askOpen = false; if (modal.parentNode) modal.parentNode.removeChild(modal); }
    var shareBtn = el('button', { class: 'btn btn-primary', type: 'button', onclick: function () {
      done();
      startSharing(db, targetId);
    } }, ['📺 Teilen']);
    var noBtn = el('button', { class: 'btn btn-ghost', type: 'button', onclick: function () {
      done();
      try { db.ref('spectate/' + targetId + '/declined').set({ ts: Date.now() }); } catch (e) {}
    } }, ['Ablehnen']);
    card.appendChild(el('div', { class: 'spec-ask-actions' }, [noBtn, shareBtn]));

    document.body.appendChild(modal);
  }

  function listenForRequests() {
    if (reqListening) return;
    var id = myKey();
    if (!id) return;
    reqListening = true;
    App.Net.firebaseDb().then(function (db) {
      db.ref('spectate/' + id + '/req').on('value', function (snap) {
        var r = snap.val();
        if (!r || !r.from) return;
        showConsent(db, String(r.from).slice(0, 40));
      });
    }).catch(function () { reqListening = false; });
  }

  /* =========================================================================
   *  ZUSCHAUER-SEITE — Anfrage stellen, Answer liefern, Video anzeigen
   * ========================================================================= */
  var activeWatch = null;   // { pc, baseRef, offRef, iceRef, decRef, video, timer }

  function teardownWatch() {
    var w = activeWatch; activeWatch = null;
    if (!w) return;
    if (w.timer) clearTimeout(w.timer);
    try { w.offRef && w.offRef.off(); } catch (e) {}
    try { w.iceRef && w.iceRef.off(); } catch (e) {}
    try { w.decRef && w.decRef.off(); } catch (e) {}
    try {
      if (w.video && w.video.srcObject) { w.video.srcObject.getTracks().forEach(function (t) { t.stop(); }); w.video.srcObject = null; }
    } catch (e) {}
    try { w.pc && w.pc.close(); } catch (e) {}
    // Fremder Knoten (gehört dem Spieler): unseren onDisconnect abbestellen und leeren.
    if (w.baseRef) { try { w.baseRef.onDisconnect().cancel(); } catch (e) {} try { w.baseRef.remove(); } catch (e) {} }
  }

  /** Overlay öffnen und den echten Live-Bildschirm von targetKey zeigen. */
  function watch(targetKey, targetName) {
    if (!fbReady()) { UI.toast('Zuschauen geht nur online.', 'lose'); return; }
    if (!hasRtc()) { UI.toast('Dein Browser kann kein Live-Bild empfangen.', 'lose'); return; }
    injectCss();
    if (App.Mods && App.Mods.log) App.Mods.log('watch', 'schaut ' + (targetName || targetKey) + ' zu');

    teardownWatch();

    var video = el('video', { class: 'spec-video', autoplay: true, playsinline: true, muted: true });
    video.muted = true;
    var statusT = el('div', { class: 'spec-status-t' }, ['Warte auf Freigabe von ' + (targetName || 'Spieler') + ' …']);
    var statusBox = el('div', { class: 'spec-status' }, [el('div', { class: 'spec-spin' }), statusT]);
    var liveTag = el('span', { class: 'spec-live wait' }, ['● WARTET']);
    var whoEl = el('div', { class: 'spec-who' }, [targetName || 'Spieler']);
    var closeBtn = el('button', { class: 'spec-close', type: 'button' }, ['✕']);
    var stage = el('div', { class: 'spec-stage' }, [video, statusBox]);
    var overlay = el('div', { class: 'spec-overlay' }, [
      el('div', { class: 'spec-tv' }, [
        el('div', { class: 'spec-bar' }, [liveTag, whoEl, closeBtn]),
        stage
      ])
    ]);
    document.body.appendChild(overlay);

    var closed = false;
    function close() {
      closed = true;
      teardownWatch();
      if (overlay.parentNode) document.body.removeChild(overlay);
    }
    function setStatus(text) { statusT.textContent = text; statusBox.style.display = ''; }
    function goLive() {
      statusBox.style.display = 'none';
      liveTag.textContent = '● LIVE';
      liveTag.classList.remove('wait');
    }
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

    App.Net.firebaseDb().then(function (db) {
      var baseRef = db.ref('spectate/' + targetKey);
      // Frisch starten: evtl. Reste einer alten Session wegräumen.
      baseRef.remove().catch(function () {}).then(function () {
        if (closed) { try { baseRef.remove(); } catch (e) {} return; }   // schon wieder geschlossen
        var pc = new RTCPeerConnection(RTC_CONFIG);
        var applier = makeIceApplier(pc);
        var offRef = baseRef.child('offer');
        var iceRef = baseRef.child('ice_callee');    // Spieler-Candidates
        var decRef = baseRef.child('declined');
        var answered = false, connected = false;

        var timer = setTimeout(function () {
          if (!connected) { setStatus(targetName ? targetName + ' hat nicht reagiert.' : 'Spieler hat nicht reagiert.'); setTimeout(close, 2200); }
        }, ANSWER_TIMEOUT_MS);

        activeWatch = { pc: pc, baseRef: baseRef, offRef: offRef, iceRef: iceRef, decRef: decRef, video: video, timer: timer };

        // Netz gegen abstürzenden Zuschauer-Tab (wird bei close() wieder abbestellt).
        try { baseRef.onDisconnect().remove(); } catch (e) {}

        pc.onicecandidate = function (e) {
          if (e.candidate) { try { baseRef.child('ice_caller').push(e.candidate.toJSON()); } catch (err) {} }
        };
        pc.ontrack = function (e) {
          var stream = (e.streams && e.streams[0]) || (e.track ? new MediaStream([e.track]) : null);
          if (stream) { video.srcObject = stream; connected = true; goLive(); }
        };
        pc.onconnectionstatechange = function () {
          var st = pc.connectionState;
          if (st === 'connected') { connected = true; }
          else if (st === 'failed' || st === 'closed' || st === 'disconnected') {
            if (activeWatch) { setStatus('Verbindung beendet.'); setTimeout(close, 1500); }
          }
        };

        // Auf Offer des Spielers warten -> Answer erstellen.
        offRef.on('value', function (snap) {
          var o = snap.val();
          if (!o || !o.sdp || answered) return;
          answered = true;
          setStatus('Verbinde …');
          pc.setRemoteDescription(new RTCSessionDescription(o))
            .then(function () { applier.setReady(); return pc.createAnswer(); })
            .then(function (ans) { return pc.setLocalDescription(ans).then(function () { baseRef.child('answer').set({ type: ans.type, sdp: ans.sdp }); }); })
            .catch(function () {});
        });
        // Spieler-ICE einsammeln (gepuffert bis RemoteDescription steht).
        iceRef.on('child_added', function (snap) { applier.add(snap.val()); });
        // Absage des Spielers.
        decRef.on('value', function (snap) {
          if (snap.val()) { UI.toast('Freigabe abgelehnt.', 'lose'); close(); }
        });

        // Zum Schluss die Anfrage stellen (löst das Modal beim Spieler aus).
        baseRef.child('req').set({ from: myName(), ts: Date.now() });
      });
    }).catch(function () { setStatus('Verbindung nicht möglich.'); setTimeout(close, 1600); });
  }

  App.Spectate = { watch: watch };

  function boot() {
    if (!fbReady()) return;
    listenForRequests();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
