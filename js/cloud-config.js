/* cloud-config.js — Adresse des geteilten Cloud-Speichers (Konten + Bestenliste).
 *
 * Anders als Firebase braucht dieser Weg KEIN Google-Konto und KEIN Projekt-Setup:
 * eine einzige, öffentliche, aber "geheime" ID reicht, unter der alle Besucher
 * der Seite denselben Datensatz lesen/schreiben (JSONBlob, https://jsonblob.com —
 * ein kostenloser, anmeldefreier JSON-Speicherdienst mit CORS-Unterstützung).
 *
 * So bekommst du deine eigene ID (kein Login, keine E-Mail, ca. 30 Sekunden):
 *   Variante A (einfachster Weg):
 *     1. Gehe auf https://jsonblob.com — dort öffnet sich direkt ein leerer
 *        JSON-Editor.
 *     2. Trage "{}" ein und klicke auf "Save" (bzw. das Speichern-Icon).
 *     3. Die Adresse in der Browser-Adresszeile ändert sich zu etwas wie
 *        https://jsonblob.com/1a2b3c4d-5e6f-... — der Teil NACH dem letzten
 *        "/" ist deine ID.
 *   Variante B (falls A nicht klappt, per Browser-Konsole F12):
 *        fetch('https://jsonblob.com/api/jsonBlob', {
 *          method: 'POST',
 *          headers: { 'Content-Type': 'application/json' },
 *          body: '{}'
 *        }).then(r => console.log(r.headers.get('Location')));
 *      Die Konsole zeigt eine URL wie https://jsonblob.com/api/jsonBlob/abcd1234-....
 *      Der Teil NACH dem letzten "/" ist deine ID.
 *
 *   Danach die ID unten bei CLOUD_STORE_ID eintragen (Platzhalter ersetzen), committen.
 *
 * Solange hier der Platzhalter steht, laufen Konten & Bestenliste im lokalen
 * Modus (nur dieser Browser). Sobald eine echte ID eingetragen ist, sind Konten
 * und Bestenliste automatisch für ALLE Besucher der Website geteilt — ganz ohne
 * Firebase/Google-Konto. Falls stattdessen eine echte Firebase-Konfiguration in
 * js/firebase-config.js hinterlegt ist, hat die Priorität (robusteres Backend).
 */
window.CLOUD_STORE_ID = '019f6002-55f3-7718-bb52-d68fc041ed22';
