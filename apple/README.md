# Freiraum für iPhone und Mac

SwiftUI-App für iOS 26 und macOS 26, dazu ein Widget (iOS) und die Menüleiste (Mac).
Entscheidungen: [ADR 0004](../docs/adr/0004-ios-app.md), Auswertungen:
[ADR 0005](../docs/adr/0005-auswertungen.md).

## Aufbau

- `project.yml`: Xcode-Projekt (XcodeGen). `Freiraum.xcodeproj` wird erzeugt, nicht eingecheckt.
- `FreiraumKit/`: Swift-Paket ohne Oberfläche, baut und testet auch unter Linux.
  - `FreiraumAPI`: Client, beim Bauen aus `openapi/openapi.yaml` erzeugt (swift-openapi-generator).
  - `FreiraumKit`: Dienst, Modelle, Beträge, Monate, Übersicht, Bestätigen, Eingaben, Widget-Schnappschuss,
    Planung (Umschichten, Abschluss), Auswertungen samt Sankey-Layout und Liste „woher/wohin“,
    Menüleiste.
- `Freiraum/`: App (Anmeldung, Übersicht, Töpfe, Bestätigen, Barausgabe, Verteilen, Einzahlungen,
  Auswertung und Ziele). `Freiraum/Views/Analytics/`: Bausteine der Auswertungen für iPhone und Mac
  (Kacheln, Diagramme, Ziele, Besitz). `Freiraum/Views/Mac/`: nur macOS (Seitenleiste, Planung,
  Auswertungen mit Sankey, Menüleiste).
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

## Mac-App installieren

1. [Freiraum.dmg laden](https://github.com/rubenvitt/freiraum/releases/latest/download/Freiraum.dmg)
   (ab dem ersten Release; signiert und notarisiert), öffnen, „Freiraum“ nach *Programme* ziehen.
2. Starten und mit Passkey anmelden (Einladung wie unter „Einrichten“).

Die App sucht stündlich nach Updates, lädt sie im Hintergrund und installiert sie beim nächsten
Beenden; da die App im Menüleistensymbol weiterläuft, kann ein Update bis zum nächsten Beenden
oder Neustart warten. „Nach Updates suchen …“ im App-Menü prüft sofort. Selbst gebaute Apps aktualisieren sich
nicht. Releases entstehen bei jedem Merge auf `main`, der `apple/**` (ohne reine `.md`-Änderungen) oder `openapi/**` ändert;
Einrichtung und Wartung: [`RELEASE.md`](RELEASE.md), Entscheidungen:
[ADR 0007](../docs/adr/0007-mac-releases.md).

## Testen

```bash
cd apple/FreiraumKit && swift test
```

Ohne Mac geht das auch per Docker:

```bash
docker run --rm -v "$PWD":/src -w /src/apple/FreiraumKit swift:6.1-noble swift test
```

Die CI (`.github/workflows/apple.yml`) testet FreiraumKit unter Linux und baut App und Widget
für iOS und macOS ohne Signatur. Lokal ohne Mac geht nur FreiraumKit; die Oberfläche prüft erst
die CI.

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
- Ausgleich von Hand (Ansicht „Ausgleich“): Wer eine offene Forderung hat, verbucht dort eine
  bar erhaltene Erstattung oder verrechnet sie mit der eigenen Einzahlung; eine offene Schuld
  lässt sich nur mit der Einzahlung verrechnen. Höchstens der eigene Saldo, eine Verrechnung
  nicht in abgeschlossenen Monaten. Eigene Einträge nimmt man per Wischen zurück.
- „Buchungen warten“ meldet die App selbst per Hintergrundabruf (etwa stündlich, iOS entscheidet).
  Im Simulator lässt sich der Abruf in Xcode über *Debug › Simulate Background Fetch* auslösen.
- Das Widget zeigt den privaten Haushalt im laufenden Monat und liest nur, was die App zuletzt
  geladen hat.
- Reiter „Auswertung“: Zeitraum (Monat, Quartal, Jahr), Kennzahlen (Sparquote, Fixkosten, Runway,
  Alter des Geldes), Geldfluss als Liste „Woher“ und „Wohin“ (statt Sankey; Gruppen statt einzelner
  Töpfe), ein Verlauf zum Umschalten, Auffälligkeiten des Monats und Besitzkosten.
- Reiter „Ziele“: Ziel-Töpfe des gewählten Haushalts mit Fortschritt und Prognose.

## Mac

- Gleiches Ziel wie am iPhone, gleiche Anmeldung per Passkey. Die Associated Domain steht in
  `Freiraum/Freiraum-macOS.entitlements`; `APPLE_APP_IDS` auf dem Server gilt für beide.
- Seitenleiste: Übersicht und Töpfe wie am iPhone, dazu **Planung** und **Auswertungen**. Haushalt
  (Ich / Gemeinsam) und Monat wählt man oben in der Werkzeugleiste; beides gilt für alle Bereiche.
- Planung: Zuweisung direkt in der Tabelle ändern (Eingabetaste), über das Menü einer Zeile oder
  „Umschichten“ Geld zwischen „Noch ohne Aufgabe“ und Töpfen verschieben (ein Aufruf, der Server
  bucht beides zusammen oder nichts). Reicht das Geld nicht, steht die Meldung des Servers im
  Blatt. Vergangene Monate lassen sich abschließen, der zuletzt abgeschlossene wieder öffnen.
- Auswertungen: Kennzahlen, Geldfluss (Sankey, mit der Maus über ein Band fahren; mit
  gemeinsamem Haushalt umschaltbar auf „Über meine Haushalte“), Verlauf von
  Sparquote, Fixkostenanteil und Alter des Geldes, Auffälligkeiten, Ziele, Besitzkosten. Der
  Zeitraum (Monat, Quartal, Jahr) endet im gewählten Monat und beginnt frühestens mit dem
  Budgetbeginn.
- Menüleiste: „Noch ohne Aufgabe“ des privaten Haushalts im laufenden Monat, wartende Buchungen
  (alle Haushalte) und die nächste Auffälligkeit. Ohne offenes Fenster läuft die App dort weiter,
  lädt alle 15 Minuten neu und meldet neue wartende Buchungen, solange sie im Hintergrund ist.
