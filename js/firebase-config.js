/* firebase-config.js — echte Firebase-Konfiguration (Realtime Database).
 *
 * Diese Werte sind bei Firebase bewusst ÖFFENTLICH (Client-SDK). Der Zugriffs-
 * schutz läuft über die Datenbank-Regeln (database.rules.json), nicht über den
 * API-Key — daher ist es normal und unbedenklich, dass sie hier im Repo stehen.
 *
 * Projekt: KlettLogin (klettlogin-3d1ed), Realtime Database in europe-west1.
 * Sobald diese Werte vorhanden sind, schalten js/net.js (Raum-Codes),
 * js/account.js (Konten) und js/leaderboard.js (Bestenliste) automatisch auf
 * das geteilte, echtzeitfähige Firebase-Backend um.
 */
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyB9e7SS4RsT86XnuCo5UVHE6nmEnmEiT_w",
  authDomain: "klettlogin-3d1ed.firebaseapp.com",
  databaseURL: "https://klettlogin-3d1ed-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "klettlogin-3d1ed",
  appId: "1:273062395503:web:724a7bfcace398dec2179a"
};
