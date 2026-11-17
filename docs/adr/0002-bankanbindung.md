# ADR 0002: Bankanbindung (E1-Spike)

Stand: 17.11.2026 · Status: **vorgeschlagen**, Entscheidung offen bis zur Prüfung der eigenen Banken (FREI-2)

## Kontext

Freiraum soll Umsätze der Konten beider Personen regelmäßig und ohne Handarbeit abrufen
(Prinzip „wenig Pflege“). Zur Wahl stehen FinTS direkt und ein PSD2-Anbieter (Spec, Abschnitt
Bankanbindung). Kriterien: alle eigenen Banken abgedeckt, Kosten, Aufwand der regelmäßigen
Zustimmung, Datenschutz.

Welche Banken genau gebraucht werden, steht bewusst nicht im (öffentlichen) Repo; die Prüfung
dazu läuft in FREI-2.

## Ergebnisse der Recherche (Stand November 2026)

### Starke Kundenauthentifizierung (SCA)

- Seit 25.07.2023 (Delegierte Verordnung (EU) 2022/2360) muss die SCA für Kontoinformationen
  nur noch **alle 180 statt 90 Tage** erneuert werden. Für den Zugriff über einen Anbieter
  (AISP) ist das Pflicht, für den direkten Zugriff (FinTS) darf die Bank es selbst entscheiden.
  Ohne erneute SCA gibt es nur Umsätze der letzten 90 Tage.
- In der Praxis unterscheiden sich die Banken: Manche verlangen bei FinTS weiter alle 90 Tage
  eine Freigabe oder einen Login ins Online-Banking, manche liefern nur 90 Tage Historie.
- Mit einem **entkoppelten Verfahren** (Freigabe in der Banking-App statt TAN-Eingabe) ist die
  Erneuerung ein Tipp auf dem Handy. Nicht jede Bank bietet das über FinTS an.

### FinTS direkt

- **Produktregistrierung** bei der Deutschen Kreditwirtschaft ist seit 2019 Pflicht, kostenlos,
  Antrag über fints.org. Die Bearbeitung dauert laut Projekten wenige bis mehrere Wochen. Fremde
  Produkt-IDs darf man nicht verwenden.
- **Bibliotheken für Node.js:** `lib-fints` ist gepflegt (letzte Version Oktober 2026,
  LGPL-2.1-or-later), kann PSD2 und entkoppelte Freigabe, liest CAMT und MT940.
  `fints-lib` (MIT) hat nach eigener README nur teilweise TAN-Unterstützung; `fints` und
  `node-fints` werden seit 2020 nicht mehr gepflegt. Als Ausweichweg gäbe es `python-fints`
  (gepflegt) als kleinen Zusatzdienst.
- **Abdeckung:** Sparkassen, Volks- und Raiffeisenbanken und die meisten Filial- und Direktbanken
  bieten FinTS an. **N26, Revolut und Trade Republic nicht**, bei manchen Direktbanken ist es
  unklar.
- **Zugangsdaten:** Jeder FinTS-Abruf braucht die **Online-Banking-PIN**. Der Server muss sie
  also kennen. Sie gehört verschlüsselt gespeichert oder nur in die Umgebung, nie in die
  Datenbank im Klartext und nie ins Repo.
- **Datenschutz:** Die Daten gehen nur zwischen Homelab und Bank, kein Dritter ist beteiligt.

### PSD2-Anbieter

- **Enable Banking** (Finnland, AISP unter Aufsicht der FIN-FSA) hat einen kostenlosen
  **„restricted mode“** für die persönliche Nutzung eigener Konten, die im Portal verknüpft
  werden; die Zahl der Konten kann begrenzt sein. Zugriff per JWT mit eigenem Schlüsselpaar.
  Die Zustimmung hält bei vielen Banken 180 Tage (`maximum_consent_validity` je Bank).
  In Deutschland werden u. a. Sparkassen, Volks- und Raiffeisenbanken und große Direktbanken
  unterstützt. Actual Budget, Firefly III und Sure nutzen Enable Banking inzwischen als
  Nachfolger von Nordigen.
- **GoCardless Bank Account Data** (früher Nordigen) nimmt **keine neuen Nutzer** mehr auf.
- **Tink, Salt Edge, Yapily, TrueLayer, finAPI**: nur Verträge für Unternehmen, kein Angebot für
  Privatpersonen. Bezahlte Zwischendienste für Selbsthoster (z. B. Lunch Flow) brächten einen
  weiteren Dritten mit Datenzugriff.
- **Zugangsdaten:** Der Server sieht keine PIN; die Zustimmung läuft über die Seite der Bank.
- **Datenschutz:** Der Anbieter sieht alle Umsätze. Bei Enable Banking ist noch zu prüfen, wo
  die Daten liegen und wie lange sie gespeichert werden.
- **Risiko:** Anbieter können Bedingungen ändern oder den Zugang schließen (siehe GoCardless).

### Bewertung

| Kriterium | FinTS direkt (`lib-fints`) | Enable Banking |
|---|---|---|
| Abdeckung | klassische Banken ja, Neobanken nein | breit, auch einige Neobanken |
| Kosten | kostenlos (Registrierung nötig, dauert Wochen) | kostenlos für persönliche Nutzung |
| Zustimmung | alle 90–180 Tage, je nach Bank; mit App-Freigabe ein Tipp | alle 180 Tage (je Bank), Weiterleitung zur Bank |
| Datenschutz | kein Dritter | Anbieter sieht alle Umsätze |
| Geheimnisse auf dem Server | Banking-PIN | privater Schlüssel fürs JWT, keine PIN |
| Abhängigkeit | Bibliothek (LGPL), DK-Registrierung | Geschäftsmodell des Anbieters |

## Vorschlag

1. **FinTS direkt mit `lib-fints` als Hauptweg** für alle Konten, deren Bank FinTS mit
   entkoppelter Freigabe anbietet. Kein Dritter sieht die Umsätze, und es entstehen keine Kosten.
   Die Produktregistrierung **sofort beantragen**, weil sie Wochen dauern kann.
2. **Enable Banking als zweiter Anbieter** nur für Konten ohne brauchbares FinTS (Neobanken,
   Banken ohne App-Freigabe über FinTS).
3. **CSV-Import** als Rückfallebene für Konten, die beides nicht können.

Ändert die Prüfung der eigenen Banken das Bild (z. B. die meisten Konten ohne FinTS), dreht sich
die Reihenfolge von 1 und 2 um. Die Importschicht hängt davon nicht ab.

## Was unabhängig vom Anbieter schon steht (E1)

- **Anbieter liefern nur gebuchte Umsätze** im Format `IncomingTransaction` (Betrag in Cent,
  Buchungstag, optional Quell-ID) an `LedgerService.importTransactions`. Vorgemerkte Umsätze
  werden nicht importiert, weil sie sich noch ändern.
- **Idempotenz:** Schlüssel `id:<Quell-ID>`, wenn die Bank eine **stabile** ID liefert, sonst
  `hash:<sha256 aus Konto, Buchungstag, Betrag, Verwendungszweck, Gegenpartei>:<Vorkommen>`. Die
  Gegenpartei (Name und IBAN) steht zusätzlich zur Spec im Hash, damit zwei verschiedene
  Empfänger mit gleichem Betrag und leerem Verwendungszweck nicht verwechselt werden. Das Vorkommen
  zählt gleiche Buchungen am selben Tag innerhalb eines Abrufs. Abrufe decken deshalb immer
  **ganze Tage** ab und überlappen ein paar Tage mit dem vorigen Abruf. Ein Adapter bleibt je
  Konto bei einer Schlüsselart; ein Wechsel (Quell-ID ↔ Hash) würde Buchungen doppelt anlegen.
- **Wiederkehrende Buchungen** werden nach jedem Import aus der Historie des Kontos neu
  berechnet (`src/ledger/recurring.ts`).

## Folgen

- Je gewähltem Anbieter ein Adapter, der Zugangsdaten nur aus Umgebung bzw. verschlüsselter
  Ablage liest und zeitgesteuert abruft. Das sind eigene Aufgaben nach der Entscheidung.
- Ablauf der Zustimmung muss rechtzeitig auffallen (Hinweis in der App, später Benachrichtigung).
- Vor dem ersten echten Import muss das Datenbank-Backup laufen (FREI-9).
