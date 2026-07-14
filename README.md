# 🎰 Neon Jungle Casino

Eine statische Spielhalle im **Neon-Dschungel-Look** — reines HTML, CSS und Vanilla JavaScript.
Kein Build-Tool, kein Framework, keine Server-Abhängigkeiten. Läuft, wenn man `index.html`
direkt öffnet **oder** über GitHub Pages hostet.

> ⚠️ Nur zum Spaß: Es wird ausschließlich mit **virtuellen Coins** gespielt. Kein Echtgeld, keine Auszahlung.

## 🕹️ Spiele
Kategorie **Gambling** mit 8 voll funktionsfähigen Spielen:

| Spiel | Kurz |
|------|------|
| 🃏 **Blackjack** | Schlag den Dealer bis 21 · Hit/Stand/Double · Blackjack zahlt 3:2 |
| 🚀 **Crash** | Multiplikator steigt — cashe aus, bevor die Rakete abstürzt |
| 🎲 **Cube-Roll** | Wette höher/niedriger/exakt auf den Würfel |
| 🎰 **Slots** | 3 Walzen, Dschungel-Symbole, Gewinntabelle |
| 🎡 **Roulette** | Europäisch — Rot/Schwarz, Gerade/Ungerade, Zahlen, Dutzende |
| 💣 **Mines** | 5×5-Feld — sichere Felder aufdecken, jederzeit auscashen |
| 🪙 **Coinflip** | Kopf oder Zahl — 50/50-Münzwurf, 1.92× Auszahlung |
| 🌀 **Glücksrad** | Dreh das Rad — Niete oder Multiplikator bis 10× |

Kategorie **Online Minigames** mit 20 Spielen — jedes **allein** oder **zusammen über das Internet** (2–8 Spieler über einen Raum-Code, kein Konto/Setup für die Mitspieler nötig):

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

Kategorie **Koop-Team** mit 5 Spielen, bei denen man **zusammen** ein Level schafft (kein Gegeneinander – geteilter Team-Zustand, gemeinsames Gewinnen/Verlieren), allein zum Üben oder als Team über das Internet:

| Spiel | Kurz |
|------|------|
| 🍳 **Koop-Küche** | Overcooked-Art: kocht & serviert die Bestellungen rechtzeitig |
| 🐉 **Drachen-Raid** | Besiegt den Boss gemeinsam – angreifen und im Team ausweichen |
| 🍣 **Fließband-Chaos** | Sortiert die Sachen ins richtige Fach, bevor sie runterfallen |
| 🔥 **Feuer-Alarm** | Löscht die sich ausbreitenden Brände, bevor der Dschungel abbrennt |
| 💣 **Bomben-Team** | Entschärft die Bombe zusammen – Drähte, Muster & Code vor Ablauf |

**Zusammen spielen:** Ein Spieler öffnet ein Minispiel → *Zusammen* → *Raum erstellen* und teilt den 4‑stelligen Code. Die anderen tippen den Code ein — fertig. Läuft über die **Firebase Realtime Database** (siehe unten), sodass die Räume von **überall über das Internet** funktionieren; ohne Firebase-Konfiguration fällt es automatisch auf **WebRTC (PeerJS)** bzw. den lokalen Modus zurück. Tab-Wechsel wirft niemanden raus (alle Timer laufen über die Wall-Clock).

## ✨ Features
- **1000 Start-Coins**, übergreifend für alle Gambling-Spiele.
- Guthaben immer sichtbar in der festen Kopfleiste.
- Einsatz-Schnellbuttons: 10, 50, 100, 500, ½, Max (Mindesteinsatz 10).
- **Game Over**, wenn das Guthaben unter 10 fällt → Neustart auf 1000.
- **Bestenliste** (Peak-Kontostand pro Run) mit Gold/Silber/Bronze und Live-Anzeige des aktiven Runs.
- **Konten mit Passwort** (Profil-Seite): einmal registrieren, danach in jedem Browser mit
  Kontoname + Passwort anmelden und exakt beim eigenen Spielstand weitermachen. Bleibt
  angemeldet, auch wenn das Browserfenster geschlossen wird. Passwort lässt sich jederzeit
  neu vergeben. Pro Konto ist immer nur **eine aktive Sitzung gleichzeitig** erlaubt (ein
  zweites Login wird abgelehnt, solange die erste Sitzung noch aktiv ist).
- Spielername im Profil änderbar.
- Responsive für Desktop und Handy.

### 🔐 Konten — geräteübergreifend (Firebase ist aktiv ✅)
Diese Seite läuft mit einem **echten geteilten Backend: Firebase Realtime Database**
(Projekt `KlettLogin`, Region `europe-west1`). Damit sind **Konten, Spielstand und
Bestenliste für alle Besucher geteilt** und funktionieren von **jedem Gerät und jedem
Browser** aus — der Login klappt überall, und die Bestenliste aktualisiert sich in
**Echtzeit** (Push, kein Polling).

`js/account.js`, `js/net.js` und `js/leaderboard.js` wählen ihr Backend automatisch, in
dieser Reihenfolge:
1. **Firebase-Konfiguration** in `js/firebase-config.js` — **aktuell aktiv**, robustestes
   Backend (geteilt + Echtzeit).
2. Sonst: **Cloud-Speicher-ID** in `js/cloud-config.js` (JSONBlob) — nur noch stiller
   Fallback, falls Firebase mal nicht erreichbar ist.
3. Sonst (ganz ohne Konfiguration, z. B. beim direkten Öffnen per `file://`): lokaler
   Modus — Konten/Bestenliste dann nur **in diesem einen Browser**.

> ℹ️ Beim direkten Doppelklick auf `index.html` (`file://`) läuft die Seite bewusst im
> lokalen Modus (kein Netz). Das geteilte Firebase-Backend greift, sobald die Seite über
> `http(s)://` geladen wird — also live über GitHub Pages.

> ⚠️ Sicherheits-Hinweis: Passwörter werden nur gehasht (SHA-256 + Salt) gespeichert,
> nicht im Klartext. Da es keinen eigenen Server gibt und die Firebase-Regeln (siehe unten)
> bewusst offen sind, könnte jemand mit Zugriff auf die Datenbank die Hashes herunterladen
> und offline zu knacken versuchen. Für eine Spaß-Seite unter Freunden/in der Klasse ist das
> ein angemessener Kompromiss — bitte trotzdem kein "echtes"/wiederverwendetes Passwort nutzen.

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
  cloud.js            Keyloser Cloud-Speicher (JSONBlob) — kein Google-/Firebase-Konto nötig
  account.js          Konten (Passwort-Login, Sitzungssperre) — lokal, Cloud-Speicher oder Firebase
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

## ☁️ Geteilte Bestenliste & geräteübergreifende Konten
**Aktueller Stand: Firebase ist eingerichtet und aktiv** (Variante B unten). Konten,
Spielstand, Bestenliste und Raum-Codes sind damit für alle Besucher geteilt und laufen
in Echtzeit — es ist **nichts weiter zu tun**.

`js/leaderboard.js`, `js/account.js` und `js/net.js` sind modular gebaut und schalten
**automatisch** auf das beste verfügbare Backend um. Die folgenden zwei Wege sind nur zur
Doku — Variante B ist bereits erledigt; Variante A ist eine konto-freie Alternative.

### Variante A: Cloud-Speicher ohne Konto (konto-freie Alternative zu Firebase)
Kein Google-Konto, keine E-Mail, keine Anmeldung irgendwo nötig — nur eine anonyme ID:
1. [https://jsonblob.com](https://jsonblob.com) öffnen (dort erscheint direkt ein leerer JSON-Editor).
2. `{}` eintragen und auf **Save** klicken.
3. Die Adresse in der Adresszeile ändert sich zu etwas wie
   `https://jsonblob.com/1a2b3c4d-5e6f-...` — den Teil **nach dem letzten `/`** kopieren.
4. Diese ID in [`js/cloud-config.js`](js/cloud-config.js) bei `CLOUD_STORE_ID` eintragen
   (Platzhalter `DEIN_CLOUD_ID` ersetzen) und committen.

Danach sind Konten und Bestenliste sofort für alle Besucher der Seite geteilt. Änderungen
von anderen Geräten können bis zu ~15 Sekunden brauchen (Polling statt Realtime-Push, da
der Dienst kostenlos und anmeldefrei ist). Läuft der Dienst mal nicht, fällt die Seite
automatisch auf den lokalen Modus zurück — nichts bricht.

> ⚠️ Diese ID ist "geheim durch Unauffindbarkeit", aber nicht durch echten Zugriffsschutz
> abgesichert: Wer den Wert im Quellcode findet, könnte die Daten theoretisch manipulieren.
> Für eine Spaß-Seite unter Freunden/in der Klasse ist das ein vertretbares Risiko — wer mehr
> Sicherheit möchte, nutzt Variante B (Firebase).

### Variante B: Firebase (robuster) — ✅ bereits eingerichtet
Dies ist das **aktuell aktive** Backend. Projekt `KlettLogin` (`klettlogin-3d1ed`),
Realtime Database in `europe-west1`, Web-App registriert, Regeln veröffentlicht — die
fünf Werte stehen bereits in `js/firebase-config.js`. Die folgende Anleitung ist nur als
Referenz gedacht, **falls das Projekt je neu aufgesetzt werden muss** (~5 Minuten, kein
Programmieren nötig):
1. **Projekt anlegen:** [console.firebase.google.com](https://console.firebase.google.com) →
   mit einem Google-Konto einloggen → "Projekt hinzufügen" (Google Analytics kann man abwählen).
2. **Realtime Database aktivieren:** im Projekt → **Build → Realtime Database → Datenbank
   erstellen** → Region wählen → Start im **Testmodus** (offen, ohne Login).
3. **Web-App registrieren:** Projekteinstellungen (Zahnrad) → "Meine Apps" → Web-Symbol `</>` →
   registrieren (kein Hosting nötig). Firebase zeigt dann `apiKey`, `authDomain`, `databaseURL`,
   `projectId`, `appId`.
4. Diese fünf Werte in [`js/firebase-config.js`](js/firebase-config.js) eintragen und committen.
5. **Datenbank-Regeln** (Reiter **Regeln**) veröffentlichen:
   ```json
   {
     "rules": {
       "rooms": { ".read": true, ".write": true },
       "leaderboard": { ".read": true, ".write": true },
       "accounts": { ".read": true, ".write": true }
     }
   }
   ```
   Bewusst offen (keine Logins/Server), da es eine Spaß-Seite ohne sensible Daten ist —
   siehe Sicherheits-Hinweis zu Passwörtern weiter oben.

Sobald das erledigt ist, erkennen `js/net.js` (Raum-Code) **und** `js/account.js`/`js/leaderboard.js`
(Konten + Bestenliste) automatisch die echte Konfiguration — am Code muss nichts weiter
geändert werden.

## 🛠️ Neue Spiele/Kategorien hinzufügen
- Neues Spiel: eine Datei `js/games/<id>.js` anlegen, in `App.Games.<id>` registrieren
  (`render(root)` liefert die UI), das `<script>` in `index.html` einhängen und die `<id>` in
  die passende Kategorie in `js/app.js` (`CATEGORIES`) aufnehmen.
- Neue Kategorie: einfach ein weiteres Objekt zu `CATEGORIES` in `js/app.js` hinzufügen.
