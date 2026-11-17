# ADR 0004: iOS-App (E3)

Stand: 17.11.2026 · Status: vorgeschlagen (mit FREI-4)

## Kontext

E3 bringt die App aufs iPhone: Übersicht, Buchungen bestätigen, Barausgabe erfassen, Widget und
die Benachrichtigung „Buchungen warten“. Die Spec legt SwiftUI Multiplatform, Swift Charts,
WidgetKit und einen aus OpenAPI generierten Client fest (ADR 0001). Offen waren Projektaufbau,
Anmeldung in der App, Barausgaben im Backend, Weg der Benachrichtigung und was das Widget zeigt.

## Entscheidungen

### Aufbau: XcodeGen und ein lokales Swift-Paket

- `apple/project.yml` beschreibt das Projekt; `xcodegen generate` erzeugt `Freiraum.xcodeproj`
  (nicht eingecheckt). So bleibt das Projekt im Diff lesbar und Konflikte in `.pbxproj` entfallen.
- Ein Ziel **Freiraum** für iOS und macOS (`supportedDestinations`), dazu **FreiraumWidget**
  (nur iOS). macOS baut mit, die eigentliche Mac-Oberfläche kommt mit E5.
- **FreiraumKit** (Swift-Paket in `apple/FreiraumKit`) enthält alles ohne Oberfläche: den Client,
  Abbildung auf eigene Modelle, Beträge und Monate, Aufbereitung von Übersicht und Bestätigen,
  Eingaben (Barausgabe, Aufteilen), Widget-Schnappschuss und die Entscheidung, wann gemeldet
  wird. Das Paket baut und testet unter Linux (`swift test`), auch in der CI.
- Persönliche Werte (Team-ID, Bundle-Präfix, Domain) stehen in `apple/Config/Local.xcconfig`,
  die nicht eingecheckt wird. Das Repo ist öffentlich.
- Mindestversion **iOS 26 / macOS 26** wegen Liquid Glass (`glassEffect`, `.glass`-Buttons,
  `tabViewBottomAccessory`). Beide Personen haben aktuelle iPhones.

### Client: swift-openapi-generator als Build-Plugin

- `FreiraumAPI` erzeugt den Client beim Bauen aus `openapi/openapi.yaml` (Verweis per Symlink).
  Nichts Generiertes liegt im Repo; ändert sich der Vertrag, bricht der Build sofort.
- Die App sieht den generierten Code nicht direkt: `FreiraumService` bildet auf eigene Modelle ab
  (Enums über `rawValue`, unbekannte Werte sind ein Fehler statt still falsch).
- Fehler: Eine Middleware liest bei Status ≥ 400 die Fehlermeldung des Servers und wirft
  `APIError` mit dem deutschen Text. 401 meldet die App ab.
- Zeitpunkte kommen mit Millisekunden (`toISOString`), deshalb
  `dateTranscoder: .iso8601WithFractionalSeconds`.
- Der Swift-Client lässt leere optionale Felder weg. Der Server nimmt deshalb `potId` in
  Aufteilungen als optional (fehlt = `null`).

### Anmeldung: Passkeys über AuthenticationServices

- Anmelden: `login/options` → System-Dialog (`ASAuthorizationPlatformPublicKeyCredentialProvider`)
  → `login/verify`. Einladung einlösen: Token eingeben, dann `registration/options` →
  Passkey anlegen → `registration/verify`. Damit braucht das erste Gerät keine Browserseite.
- Voraussetzung: Associated Domain `webcredentials:<Domain>` in der App und
  `APPLE_APP_IDS=<TEAMID>.<Bundle-ID>` auf dem Server (liefert apple-app-site-association).
- Das Sitzungs-Token liegt im Schlüsselbund dieses Geräts
  (`AfterFirstUnlockThisDeviceOnly`, damit der Hintergrundabruf es lesen kann), nie in der
  App Group und nie im Widget.

### Barausgaben: eigener Endpunkt

- `POST /v1/accounts/{accountId}/cash-expenses` legt im Bargeldkonto eine **bestätigte** Ausgabe
  an, gleich einem Topf zugeordnet. Import in Bargeldkonten bleibt gesperrt.
- Idempotent über eine `clientId`, die die App einmal je Eingabe erzeugt (Schlüssel
  `app:<clientId>`). Ein erneuter Versuch nach einem Netzfehler bucht nicht doppelt.
- Es entsteht keine Regel; die Erst-ich-Automatik läuft nicht (eine Ausgabe ändert keine
  Einnahmen).
- Fehlt im Haushalt ein Bargeldkonto, legt die App beim ersten Erfassen eins an („Bargeld“).
- Eine Abhebung am Automaten ordnet man als **Umbuchung** zu; erst die erfassten Barausgaben
  belasten Töpfe.

### Bargeldbestand (FREI-24)

- Eine Umbuchung kann ihr **Gegenkonto** nennen (`counterAccountId` an Aufteilung, Regel und
  Vorschlag; nur bei `umbuchung`, nur ein Konto desselben Haushalts, nie das Konto selbst; die
  Datenbank prüft das per Constraint-Trigger). Eine Abhebung bucht man so „ins Bargeld“.
- **Bestand je Bargeldkonto** = Zugänge − erfasste Ausgaben, genauer: −Summe der Umbuchungen
  anderer Konten mit diesem Konto als Gegenkonto plus Summe der Buchungen des Bargeldkontos
  selbst. Vorgeschlagene Umbuchungen zählen schon mit (wie im Budget). `GET /v1/accounts` liefert
  ihn als `unrecordedCashCents` (bei anderen Konten `null`). Negativ heißt: mehr erfasst als
  abgehoben (z. B. Bargeld aus der Zeit vor Freiraum); die App zeigt dann nichts.
- Das Budget bleibt unberührt: Umbuchungen sind neutral, nur erfasste Barausgaben belasten Töpfe.
- Wer eine Abhebung ins Bargeld bucht, lernt eine Regel **mit** Gegenkonto; die nächste Abhebung
  derselben Gegenpartei kommt gleich so als Vorschlag. Der IBAN-Abgleich setzt das Gegenkonto
  bei Überweisungen zwischen eigenen Konten ebenfalls.
- Verworfen: Bestand allein aus Umbuchungen ohne Gegenkonto ableiten (z. B. „Umbuchung ohne
  passende IBAN = Bargeld“). Eine Umbuchung aufs nicht angelegte Sparkonto sähe genauso aus.
- App: Erkennt die Bestätigen-Karte eine Abhebung (Wörter wie „Bargeld“, „Geldautomat“), bietet
  sie „Ins Bargeld buchen“ an (legt bei Bedarf das Bargeldkonto an). Danach erinnert sie „Denk an
  die 50 € Bargeld“; die Übersicht zeigt „30 € Bargeld noch nicht erfasst“ und öffnet von dort
  die Barausgabe.
- Vertrag: `SplitInput` ist ein eigenständiges Objekt statt einer Erweiterung von `Split`. Die
  Erweiterung wurde im Vertrag ein `allOf`, das der Swift-Client als Verschachtelung
  (`value1`/`value2`) erzeugt; jedes neue Feld hätte dort zweimal gesetzt werden müssen.

### Benachrichtigung „Buchungen warten“: lokal per Hintergrundabruf

- Die App plant einen `BGAppRefreshTask` (frühestens stündlich, iOS entscheidet), lädt die
  offenen Buchungen und meldet sich lokal, wenn **neue** IDs dazugekommen sind. Gemerkt werden
  IDs, nicht die Anzahl. Ist die App offen, gelten die Buchungen als gesehen.
- Das App-Symbol zeigt die Zahl der wartenden Buchungen.
- Verworfen für jetzt: **Push über APNs**. Braucht einen APNs-Schlüssel auf dem Server, Geräte-
  Tokens in der Datenbank und einen Versand nach dem zeitgesteuerten Abruf (FREI-12). Lohnt sich,
  sobald der Abruf läuft; bis dahin kommen Buchungen ohnehin nur in größeren Abständen.

### Widget: Schnappschuss statt eigener Abfrage

- Die App schreibt nach jedem Laden einen `WidgetSnapshot` (JSON) in die App Group und lädt die
  Widgets neu. Das Widget liest nur diese Datei: kein Token, keine Netzabfrage im Widget.
- Inhalt: privater Haushalt im laufenden Monat, „Noch ohne Aufgabe“, frei in den Monatstöpfen,
  die drei knappsten Töpfe, Zahl der wartenden Buchungen. Größen: klein, mittel, Sperrbildschirm.
- Gehört der Schnappschuss zu einem vergangenen Monat, zeigt das Widget einen Hinweis statt
  alter Zahlen.

### Darstellung

- Dunkles Design wie im Entwurf (Minze = gut/Aktion, Orange = knapp/überzogen/Hinweis,
  Blau = gemeinsam, Violett = privat); die App erzwingt vorerst das dunkle Erscheinungsbild.
- Beträge formatiert FreiraumKit selbst (Tausenderpunkt, Dezimalkomma, echtes Minus), damit
  App, Widget und Tests gleich aussehen.

## Folgen

- Wer `openapi/openapi.yaml` ändert, sieht Brüche im Swift-Client in der CI (Job „FreiraumKit“).
- Für die erste Anmeldung muss `APPLE_APP_IDS` auf dem Server gesetzt sein, sonst lehnt iOS den
  Passkey ab.
- Offen: Push über APNs, Töpfe in der App anlegen und bearbeiten, Widget für den
  gemeinsamen Haushalt (Auswahl per App Intent), helles Erscheinungsbild. Paar-Funktionen
  (Freigaben, Ausgleich) kommen mit E4.
