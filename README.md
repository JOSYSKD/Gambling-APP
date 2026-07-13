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

## ✨ Features
- **1000 Start-Coins**, übergreifend für alle Spiele, gespeichert im `localStorage`.
- Guthaben immer sichtbar in der festen Kopfleiste.
- Einsatz-Schnellbuttons: 10, 50, 100, 500, ½, Max (Mindesteinsatz 10).
- **Game Over**, wenn das Guthaben unter 10 fällt → Neustart auf 1000.
- **Bestenliste** (Peak-Kontostand pro Run) mit Gold/Silber/Bronze und Live-Anzeige des aktiven Runs.
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
  games/              je ein Modul pro Spiel (registrieren sich in App.Games)
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

## 🔌 Später: Online-Bestenliste
`js/leaderboard.js` ist modular: Über `App.Leaderboard.useDriver(deinDriver)` lässt sich der
localStorage-Driver durch ein Backend (z. B. Firebase) mit den Methoden `load()`/`save(entries)`
ersetzen — ohne den Rest der App anzufassen.

## 🛠️ Neue Spiele/Kategorien hinzufügen
- Neues Spiel: eine Datei `js/games/<id>.js` anlegen, in `App.Games.<id>` registrieren
  (`render(root)` liefert die UI), das `<script>` in `index.html` einhängen und die `<id>` in
  die passende Kategorie in `js/app.js` (`CATEGORIES`) aufnehmen.
- Neue Kategorie: einfach ein weiteres Objekt zu `CATEGORIES` in `js/app.js` hinzufügen.
