# Freiraum für iPhone (und Mac)

SwiftUI-App für iOS 26 und macOS 26, dazu ein Widget. Entscheidungen: [ADR 0004](../docs/adr/0004-ios-app.md).

## Aufbau

- `project.yml`: Xcode-Projekt (XcodeGen). `Freiraum.xcodeproj` wird erzeugt, nicht eingecheckt.
- `FreiraumKit/`: Swift-Paket ohne Oberfläche, baut und testet auch unter Linux.
  - `FreiraumAPI`: Client, beim Bauen aus `openapi/openapi.yaml` erzeugt (swift-openapi-generator).
  - `FreiraumKit`: Dienst, Modelle, Beträge, Monate, Übersicht, Bestätigen, Eingaben, Widget-Schnappschuss.
- `Freiraum/`: App (Anmeldung, Übersicht, Töpfe, Bestätigen, Barausgabe, Verteilen, Einzahlungen).
- `FreiraumWidget/`: Widget „Freies Budget“.
- `Config/`: Build-Einstellungen; persönliche Werte in `Local.xcconfig` (nicht im Repo).

## Einrichten

1. XcodeGen installieren: `brew install xcodegen`
2. `cp Config/Local.xcconfig.example Config/Local.xcconfig` und ausfüllen:
   Team-ID, Bundle-Präfix, Domain des Backends (= `WEBAUTHN_RP_ID`).
3. Im Apple-Developer-Konto für die App-ID die Fähigkeiten **Associated Domains** und
   **App Groups** aktivieren (Xcode erledigt das bei automatischer Signatur meist selbst).
4. Auf dem Server `APPLE_APP_IDS=<TEAMID>.<Bundle-Präfix>.freiraum` setzen und neu starten.
   Prüfen: `https://<Domain>/.well-known/apple-app-site-association` liefert die App-ID.
5. `xcodegen generate`, dann `Freiraum.xcodeproj` öffnen und auf dem iPhone starten.
   Beim ersten Bauen fragt Xcode, ob es dem Plugin „OpenAPIGenerator“ vertrauen soll: ja.

Erste Anmeldung: Auf dem Server `node dist/cli.js person-anlegen "<Name>"` (oder `einladen`),
in der App „Einladung einlösen“, Token einfügen, Passkey anlegen. Danach reicht
„Mit Passkey anmelden“.

## Testen

```bash
cd apple/FreiraumKit && swift test
```

Ohne Mac geht das auch per Docker:

```bash
docker run --rm -v "$PWD":/src -w /src/apple/FreiraumKit swift:6.1-noble swift test
```

Die CI (`.github/workflows/apple.yml`) testet FreiraumKit unter Linux und baut App und Widget
für iOS und macOS ohne Signatur.

## Hinweise

- Neuer Haushalt: In den Einstellungen unter „Budgetbeginn und Kontostände“ den Startmonat wählen,
  Konten anlegen (falls der Import noch keine kennt) und je Konto einen Kontostand mit Stichtag
  eintragen. Die Summe zählt im Startmonat zu „Noch ohne Aufgabe“.
- Töpfe richtet die App selbst ein: Reiter „Töpfe“, Knopf oben rechts (Tippen = neuer Topf,
  gedrückt halten = Reihenfolge und archivierte Töpfe). Bearbeiten und Archivieren über langes
  Drücken auf einen Topf oder „Topf bearbeiten“ im Zuweisungsblatt. Geleert werden Felder über
  `clear` im `PATCH`, weil der generierte Client `null` nicht sendet.
- Einzahlungen ins Gemeinsame: In der Übersicht „Gemeinsam“ zeigt die Karte „Einzahlungen“ Soll
  und Ist beider Personen im Monat. Antippen öffnet die eigene Regel (fest oder Anteil vom Netto,
  gültig ab einem Monat), die Freigabe des Solls und den Verlauf; eigene Regeln löscht man dort
  per Wischen. Das Soll der anderen Person steht nur da, wenn es fest ist oder freigegeben wurde.
- Barausgaben landen im Bargeldkonto des Haushalts; fehlt es, legt die App beim ersten Erfassen
  eins an. Abhebungen am Automaten bucht „Ins Bargeld buchen“ als Umbuchung ins Bargeldkonto;
  die Übersicht zeigt dann, wie viel davon noch nicht als Ausgabe erfasst ist.
- Gemeinsames Konto, privater Einkauf: beim Bestätigen „Ändern“ und einen Topf unter
  „Privat (ich zahle zurück)“ wählen. Der Betrag steht dann als Schuld im Ausgleich (Übersicht
  „Gemeinsam“). Zurückgezahlt wird per Überweisung aufs gemeinsame Konto, die man dort als
  „Rückzahlung von …“ zuordnet (nicht als Einzahlung). Umgekehrt landet ein gemeinsamer Topf vom
  privaten Konto als Forderung im Ausgleich.
- „Buchungen warten“ meldet die App selbst per Hintergrundabruf (etwa stündlich, iOS entscheidet).
  Im Simulator lässt sich der Abruf in Xcode über *Debug › Simulate Background Fetch* auslösen.
- Das Widget zeigt den privaten Haushalt im laufenden Monat und liest nur, was die App zuletzt
  geladen hat.
