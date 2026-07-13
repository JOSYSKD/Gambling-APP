/* firebase-config.js — hier kommt deine Firebase-Konfiguration rein.
 *
 * Ersetze die Platzhalter durch den Block aus der Firebase-Konsole
 * (Projekteinstellungen → Meine Apps → Web-App → SDK-Konfiguration).
 * Wichtig ist besonders `databaseURL` (Realtime Database).
 *
 * Solange hier Platzhalter stehen, läuft der Online-Multiplayer im
 * LOKAL-Modus (nur mehrere Tabs im selben Browser, zum Ausprobieren).
 * Sobald echte Werte drinstehen, spielen deine Freunde über Firebase mit.
 */
window.FIREBASE_CONFIG = {
  apiKey: "DEIN_API_KEY",
  authDomain: "DEIN_PROJEKT.firebaseapp.com",
  databaseURL: "https://DEIN_PROJEKT-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "DEIN_PROJEKT",
  appId: "DEINE_APP_ID"
};
