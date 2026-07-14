# 🎰 Neon Jungle Casino

Eine statische Spielhalle im **Neon-Dschungel-Look** — reines HTML, CSS und Vanilla JavaScript.
Kein Build-Tool, kein Framework, keine Server-Abhängigkeiten. Läuft, wenn man `index.html`
direkt öffnet **oder** über GitHub Pages hostet.

> ⚠️ Nur zum Spaß: Es wird ausschließlich mit **virtuellen Coins** gespielt. Kein Echtgeld, keine Auszahlung.

## 🕹️ Spiele
Kategorie **Gambling** mit 6 voll funktionsfähigen Spielen:

| Spiel | Kurz |
|------|------|
| 🃏 **Blackjack** | Schlag den Dealer bis 21 · Hit/Stand/Double · Blackjack zahlt 3:2 |
| 🚀 **Crash** | Multiplikator steigt — cashe aus, bevor die Rakete abstürzt |
| 🎲 **Cube-Roll** | Wette höher/niedriger/exakt auf den Würfel |
| 🎰 **Slots** | 3 Walzen, Dschungel-Symbole, Gewinntabelle |
| 🎡 **Roulette** | Europäisch — Rot/Schwarz, Gerade/Ungerade, Zahlen, Dutzende |
| 💣 **Mines** | 5×5-Feld — sichere Felder aufdecken, jederzeit auscashen |

Kategorie **Online Minigames** mit 20 Spielen — jedes **allein** oder **zusammen im selben WLAN** (2–8 Spieler über einen Raum-Code, kein Konto/Setup nötig):

| Spiel | Kurz |
|------|------|
| 🍯 **Jungle Tycoon** | Idle-Clicker — sammle in der Rundenzeit den meisten Nektar |
| ⚡ **Reflex-Blitz** | Reaktionstest — schlag zu, sobald es grün wird |
| 👆 **Tap-Battle** | So schnell tippen wie möglich |
| 🃏 **Dschungel-Memory** | Pärchen aufdecken gegen die Zeit |
| 🎨 **Simon-Sequenz** | Merke dir die leuchtende Farbfolge |
| 🔢 **Kopf-Rechnen** | Schnelle Rechenaufgaben unter Zeitdruck |
| 🎯 **Ziel-Jäger** | Triff fliegende Ziele mit Combo-Bonus |
| 🌈 **Farb-Chaos** | Stroop-Test — klicke die Schriftfarbe, nicht das Wort |
| 🐍 **Dschungel-Schlange** | Snake — friss und wachse |
| 🦜 **Papagei-Flug** | Flappy-Bird durch die Ranken-Lücken |
| 🍉 **Frucht-Slicer** | Zerschneide Früchte, meide die Bomben |
| 🧱 **Turm-Stapler** | Staple die Blöcke möglichst exakt |
| 🎈 **Ballon-Risiko** | Pump für mehr Punkte — nicht platzen lassen! |
| ⌨️ **Wort-Rausch** | Tipp-Rennen — Wörter schnell und fehlerfrei |
| 🔼 **Höher oder Tiefer** | Rate die nächste Karte, jage die Serie |
| 🧩 **2048 Dschungel** | Kacheln schieben und verschmelzen |
| ❓ **Quiz-Rausch** | Möglichst viele Fragen richtig |
| 🔴 **4 Gewinnt** | Duell zu zweit / gegen den Bot |
| ⭕ **Tic-Tac-Toe** | Drei gewinnt, Best of 5 |
| 🏓 **Neon-Pong** | Der Klassiker, erster auf 7 gewinnt |
| 🏃 **Dschungel-Flucht** | Endlosläufer – **zwei Sieger**: bester Läufer (Geschick) & Münz-König |
| 🗼 **Wackelturm** | Balance-Stapelrennen (Tricky-Towers-Art), 2–4 Spieler zur Ziel-Linie |

Kategorie **Koop-Team** mit 5 Spielen, bei denen man **zusammen** ein Level schafft (kein Gegeneinander – geteilter Team-Zustand, gemeinsames Gewinnen/Verlieren), allein zum Üben oder als Team im selben WLAN:

| Spiel | Kurz |
|------|------|
| 🍳 **Koop-Küche** | Overcooked-Art: kocht & serviert die Bestellungen rechtzeitig |
| 🐉 **Drachen-Raid** | Besiegt den Boss gemeinsam – angreifen und im Team ausweichen |
| 🍣 **Fließband-Chaos** | Sortiert die Sachen ins richtige Fach, bevor sie runterfallen |
| 🔥 **Feuer-Alarm** | Löscht die sich ausbreitenden Brände, bevor der Dschungel abbrennt |
| 💣 **Bomben-Team** | Entschärft die Bombe zusammen – Drähte, Muster & Code vor Ablauf |

**Zusammen spielen:** Ein Spieler öffnet ein Minispiel → *Zusammen* → *Raum erstellen* und teilt den 4‑stelligen Code. Die anderen tippen den Code ein — fertig. Läuft per **WebRTC (PeerJS)** direkt zwischen den Geräten, ohne Server-Konto (inkl. STUN/TURN-Relay für Verbindungen über verschiedene Netzwerke/NATs hinweg). Tab-Wechsel wirft niemanden raus (alle Timer laufen über die Wall-Clock).

## ✨ Features
- **1000 Start-Coins**, übergreifend für alle Gambling-Spiele, gespeichert im `localStorage`.
- Guthaben immer sichtbar in der festen Kopfleiste.
- Einsatz-Schnellbuttons: 10, 50, 100, 500, ½, Max (Mindesteinsatz 10).
- **Game Over**, wenn das Guthaben unter 10 fällt → Neustart auf 1000.
- **Bestenliste** (Peak-Kontostand pro Run) mit Gold/Silber/Bronze und Live-Anzeige des aktiven Runs — geräteübergreifend für alle Besucher, sobald eine echte Firebase-Konfiguration hinterlegt ist (siehe unten), sonst lokal auf dem jeweiligen Gerät.
- Spielername im Profil änderbar.
- Responsive für Desktop und Handy.

## 📂 Struktur
```
index.html            SPA-Shell (feste Kopfleiste, View-Container, Overlays)
css/style.css         Neon-Dschungel-Design + gemeinsame Komponenten
js/
  storage.js          localStorage-Wrapper (mit Fallback)
  coins.js            Coin-System: Guthaben, Peak-Tracking, Game Over
  leaderboard.js      Bestenliste (modular — Backend-Driver austauschbar)
  ui.js               UI-Helfer: Einsatz-Panel, Flash/Toast, DOM-Helfer
  router.js           Hash-Router (funktioniert unter file://)
  app.js              Menü, Navigation, Views, Game-Over
  games/              je ein Modul pro Gambling-Spiel (registrieren sich in App.Games)
  net.js              Multiplayer-Räume (PeerJS/WebRTC, Fallback lokal) — Room-API
  minigames.js        Minigame-Hub: Übersicht, Modus-Wahl, Lobby mit Raum-Code
  mgutil.js           gemeinsame Bausteine (App.MG): Countdown, Timer, Live-Rangliste, Podest
  minigames/          je ein Modul pro Minispiel (registrieren sich in App.Minigames)
```
Die App ist eine **Single-Page-App mit Hash-Routing** (`#/`, `#/category/gambling`,
`#/game/slots`, `#/leaderboard`, `#/profile`). Bewusst **klassische `<script>`-Tags**
statt ES-Module, damit das direkte Öffnen von `index.html` (`file://`) ohne Server funktioniert.

## ▶️ Lokal ausprobieren
Einfach **`index.html` im Browser öffnen** (Doppelklick). Fertig — kein Server nötig.

## 🚀 Auf GitHub Pages veröffentlichen
1. Dieses Repo auf GitHub liegen haben (Dateien im Branch `main`).
2. Auf GitHub: **Settings → Pages**.
3. Unter **Build and deployment → Source**: **Deploy from a branch** wählen.
4. **Branch: `main`**, **Ordner: `/ (root)`** auswählen → **Save**.
5. Nach ~1 Minute ist die Seite erreichbar unter:
   `https://<dein-benutzername>.github.io/<repo-name>/`
   (für dieses Repo: `https://josyskd.github.io/Klett-Login/`).

Alle Pfade sind **relativ**, daher funktioniert die Seite auch im Unterordner `/<repo-name>/`.
Die Datei `.nojekyll` sorgt dafür, dass GitHub Pages die Dateien 1:1 ausliefert.

## 🔌 Online-Bestenliste (geräteübergreifend)
`js/leaderboard.js` erkennt automatisch, ob in `js/firebase-config.js` eine echte Firebase-
Konfiguration hinterlegt ist (die Platzhalter `DEIN_...` sind dann ersetzt) und schaltet dann
selbstständig von localStorage auf einen Firebase-Driver um — dieselbe Konfiguration, die auch
für den Online-Multiplayer in `js/net.js` genutzt wird. Ab dann sehen **alle Besucher** derselben
Seite dieselbe Bestenliste, nicht nur die eigenen Runs.

Firebase-Einrichtung: Projekt in der [Firebase-Konsole](https://console.firebase.google.com)
anlegen, **Realtime Database** aktivieren und die Werte aus *Projekteinstellungen → Meine Apps →
Web-App → SDK-Konfiguration* in `js/firebase-config.js` eintragen. Damit fremde Besucher Einträge
schreiben können (kein Login nötig), müssen die Realtime-Database-Regeln offenen Zugriff auf die
genutzten Pfade erlauben, z. B.:
```json
{
  "rules": {
    "leaderboard": { ".read": true, ".write": true },
    "rooms": { ".read": true, ".write": true }
  }
}
```
Ohne echte Konfiguration läuft die Bestenliste weiterhin lokal im `localStorage` — ohne den Rest
der App anzufassen, da `js/leaderboard.js` modular gehalten ist (`App.Leaderboard.useDriver(...)`).

## 🛠️ Neue Spiele/Kategorien hinzufügen
- Neues Spiel: eine Datei `js/games/<id>.js` anlegen, in `App.Games.<id>` registrieren
  (`render(root)` liefert die UI), das `<script>` in `index.html` einhängen und die `<id>` in
  die passende Kategorie in `js/app.js` (`CATEGORIES`) aufnehmen.
- Neue Kategorie: einfach ein weiteres Objekt zu `CATEGORIES` in `js/app.js` hinzufügen.
