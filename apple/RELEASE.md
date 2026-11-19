# Mac-Release einrichten

Jeder Merge auf `main`, der `apple/**`, `openapi/**` oder den Workflow ändert, baut über
`.github/workflows/mac-release.yml` eine signierte, notarisierte Mac-App und legt einen
GitHub-Release an. Die installierte App aktualisiert sich selbst (Sparkle).
Entscheidungen: [ADR 0007](../docs/adr/0007-mac-releases.md).

Ohne die Einrichtung unten endet der Workflow mit einer Warnung und ohne Release (grün). Fehlt nur
ein Teil der Secrets oder Variablen, schlägt er mit der Liste der fehlenden Namen fehl.
Werte nie in Chats, Tickets oder Commits ablegen.

Platzhalter in dieser Anleitung: Team-ID `ABCDE12345`, Bundle-Präfix `de.example`,
Domain `freiraum.example.org`. Die App-ID ist `<Präfix>.freiraum`, hier `de.example.freiraum`.

## 1. Developer-Portal

Auf [developer.apple.com](https://developer.apple.com/account) unter *Certificates, IDs & Profiles*:

1. **App-ID** `de.example.freiraum` (Identifiers, Typ App IDs) mit der Fähigkeit
   **Associated Domains**. Existiert vermutlich schon vom iPhone-Bauen: prüfen, Fähigkeit aktivieren.
2. **Zertifikat** „Developer ID Application“ (Certificates, Plus, Software):
   1. Am Mac *Schlüsselbundverwaltung › Zertifikatsassistent › Zertifikat einer Zertifizierungsstelle
      anfordern*. E-Mail eintragen, „Auf der Festplatte sichern“, `.certSigningRequest` speichern.
   2. Im Portal die CSR hochladen, Zertifikat laden und doppelklicken (landet im Schlüsselbund
      „Anmeldung“).
3. **Provisioning-Profil** (Profiles, Plus, Distribution, **Developer ID**): App-ID
   `de.example.freiraum` und das Zertifikat aus Schritt 2 wählen, Profil laden
   (`.provisionprofile`).

## 2. Zertifikat und Profil als Base64

1. In der Schlüsselbundverwaltung unter *Anmeldung › Meine Zertifikate* das Zertifikat
   „Developer ID Application: …“ **samt privatem Schlüssel** wählen (Pfeil aufklappen), Rechtsklick,
   „Exportieren …“, Format `.p12`, ein Passwort vergeben. Das Passwort wird `MACOS_CERTIFICATE_PASSWORD`.
2. Base64 in die Zwischenablage:

   ```bash
   base64 -i Zertifikat.p12 | pbcopy                       # -> MACOS_CERTIFICATE_P12
   base64 -i Freiraum_Developer_ID.provisionprofile | pbcopy   # -> MACOS_PROVISIONING_PROFILE
   ```

3. Danach `.p12` und `.certSigningRequest` löschen, sobald die Secrets eingetragen sind.

## 3. App-Store-Connect-API-Schlüssel (Notarisierung)

[appstoreconnect.apple.com](https://appstoreconnect.apple.com) › *Benutzer und Zugriff* ›
*Integrationen* › *Team-Schlüssel* › Plus. Name z. B. „Freiraum Notarisierung“, Zugriff
**Developer**. Danach:

- **Schlüssel-ID** wird `ASC_KEY_ID`.
- **Issuer-ID** (oben auf der Seite) wird `ASC_ISSUER_ID`.
- Die `.p8`-Datei lässt sich nur **einmal** laden. Ihr **Inhalt** (Text mit
  `-----BEGIN PRIVATE KEY-----`) wird `ASC_KEY_P8`: `pbcopy < AuthKey_XXXX.p8`. Der Workflow
  nimmt auch den Base64-Text der Datei.

## 4. Sparkle-Schlüssel

Sparkle signiert Updates mit einem EdDSA-Schlüsselpaar. Am Mac:

1. Ein [Sparkle-2-Release](https://github.com/sparkle-project/Sparkle/releases) laden
   (`Sparkle-2.x.tar.xz`) und entpacken.
2. Im entpackten Ordner:

   ```bash
   ./bin/generate_keys                      # legt das Paar im Schlüsselbund an, gibt den öffentlichen Schlüssel aus
   ./bin/generate_keys -x sparkle_private.txt   # exportiert den privaten Schlüssel
   pbcopy < sparkle_private.txt             # -> SPARKLE_PRIVATE_KEY
   ```

   Der **Inhalt** der Datei ist das Secret: eine einzelne Base64-Zeile, genau so, wie `-x` sie
   schreibt. Danach `sparkle_private.txt` löschen. Der Schlüssel bleibt im Schlüsselbund; dort
   gehört eine Sicherung hin (z. B. Passwortverwaltung).
3. Der **öffentliche** Schlüssel (Ausgabe von `./bin/generate_keys`, auch mit `-p` erneut
   abrufbar) wird die Variable `SPARKLE_PUBLIC_KEY`.

Geht der private Schlüssel verloren, nehmen installierte Apps keine Updates mehr an; dann hilft
nur ein neuer Download per Hand.

## 5. GitHub: Secrets und Variablen

Repo › *Settings* › *Secrets and variables* › *Actions*. Secrets unter „Secrets“, Variablen unter
„Variables“, jeweils auf Repo-Ebene.

| Name | Art | Woher |
| --- | --- | --- |
| `APPLE_TEAM_ID` | Variable | Developer-Portal › Mitgliedschaft (10 Zeichen, z. B. `ABCDE12345`) |
| `FREIRAUM_BUNDLE_PREFIX` | Variable | wie in `Local.xcconfig` (z. B. `de.example`) |
| `FREIRAUM_DOMAIN` | Variable | Domain des Backends = `WEBAUTHN_RP_ID`, ohne `https://` |
| `SPARKLE_PUBLIC_KEY` | Variable | Schritt 4, Ausgabe von `generate_keys` |
| `MACOS_CERTIFICATE_P12` | Secret | Schritt 2, Base64 der `.p12` |
| `MACOS_CERTIFICATE_PASSWORD` | Secret | Schritt 2, Passwort beim Export |
| `MACOS_PROVISIONING_PROFILE` | Secret | Schritt 2, Base64 des Developer-ID-Profils |
| `ASC_KEY_ID` | Secret | Schritt 3, Schlüssel-ID |
| `ASC_ISSUER_ID` | Secret | Schritt 3, Issuer-ID |
| `ASC_KEY_P8` | Secret | Schritt 3, Inhalt der `.p8` |
| `SPARKLE_PRIVATE_KEY` | Secret | Schritt 4, Inhalt von `sparkle_private.txt` |

Der Workflow schreibt aus den Variablen eine `apple/Config/Local.xcconfig` (Team, Präfix, Domain,
Feed-URL des Repos, Sparkle-Schlüssel, manuelle Signatur mit „Developer ID Application“ und dem
Profil) und löscht sie am Ende wieder. Lokal ändert sich nichts.

## 6. Server

Auf dem Server in `deploy/.env` setzen und neu starten:

```
APPLE_APP_IDS=ABCDE12345.de.example.freiraum
```

Prüfen: `https://freiraum.example.org/.well-known/apple-app-site-association` nennt die App-ID.
Siehe [`deploy/README.md`](../deploy/README.md).

## 7. Erster Lauf

Voraussetzung: Der Server liefert `apple-app-site-association` mit der App-ID aus Schritt 6
(sonst scheitert die Passkey-Anmeldung in Punkt 4).

GitHub bietet „Run workflow“ erst an, wenn der Workflow auf `main` liegt. Deshalb:

1. PR mergen. Der Lauf auf `main` endet mangels Secrets mit Warnung, ohne Release.
   (Sind die Secrets schon da, läuft der erste Release sofort.)
2. Secrets und Variablen eintragen (Schritt 5).
3. *Actions* › **Mac-Release** › *Run workflow*, Branch `main`, **dry_run** angehakt (Standard).
   Der Lauf baut, signiert, notarisiert und lädt das DMG als Artefakt `Freiraum-<Version>` hoch.
4. Artefakt laden, entpacken, `Freiraum.dmg` öffnen, App nach *Programme* ziehen, starten und mit
   Passkey anmelden. Funktioniert die Anmeldung, stimmen Signatur, Profil und Associated Domain.
5. Noch einmal *Run workflow*, **dry_run** abgehakt: der erste echte Release. Ab da erzeugt jeder
   passende Merge auf `main` einen.

6. Update-Test: Die Probe-App (aus Punkt 4, Version `0.1.<N>`) installiert lassen und den ersten
   echten Release veröffentlichen (Punkt 5). Dann in der Probe-App *Nach Updates suchen …*
   wählen: Sie muss `0.1.<N+1>` finden und installieren. Das beweist auch, dass
   `SPARKLE_PUBLIC_KEY` zum `SPARKLE_PRIVATE_KEY` passt; ein Fehlpaar zeigt sich sonst erst, wenn
   Updates stillschweigend nicht ankommen.

Der Download-Link ist dann
`https://github.com/rubenvitt/freiraum/releases/latest/download/Freiraum.dmg`.

## 8. Wartung

- **Zertifikat:** „Developer ID Application“ gilt 5 Jahre. Vorher neu anlegen (Schritt 1.2), neues
  Profil erzeugen (das Profil hängt am Zertifikat), Schritt 2 wiederholen, `MACOS_CERTIFICATE_P12`,
  `MACOS_CERTIFICATE_PASSWORD` und `MACOS_PROVISIONING_PROFILE` ersetzen. Schon installierte Apps
  laufen weiter.
- **Profil:** Läuft es ab oder ändert sich die App-ID (neue Fähigkeit), neu erzeugen und
  `MACOS_PROVISIONING_PROFILE` ersetzen. Gilt auch, wenn das Portal es als „ungültig“ markiert.
- **Version erhöhen:** `MARKETING_VERSION` in `project.yml` von `"0.1"` auf `"0.2"` setzen und
  mergen. Die CI macht daraus `0.2.<Lauf>`; die Build-Nummer läuft weiter hoch.
- **Andere Releases:** `gh release create … --latest=false`. „Latest“ gehört dem Mac-Release, weil
  der Update-Feed über `releases/latest/download/appcast.xml` läuft. Ohne die Option finden
  installierte Apps keine Updates mehr (ADR 0007).
- **Sparkle-Schlüssel rotieren:** Neuer Sparkle-Schlüssel heißt: alle installierten Apps müssen einmal per
  Hand neu geladen werden. Nur im Notfall.

## Fehlersuche

- **Lauf endet grün, aber ohne Release:** Warnung „Signatur-Secrets nicht konfiguriert“. Secrets
  eintragen. Bei „Es fehlen: …“ nennt die Meldung die fehlenden Namen. Weitere Ursache: manueller
  Start von einem anderen Branch als `main` oder mit `dry_run`.
- **Erneuter Lauf nach erfolgreichem Release:** Der Workflow meldet „Release macos-v… existiert
  schon“ und überspringt das Anlegen; das ist gewollt. Für einen neuen Release einen neuen Merge
  (neue Lauf-Nummer) auslösen.
- **Keine Identität „Developer ID Application“:** Die `.p12` enthält den privaten Schlüssel nicht
  (Zertifikat ohne aufgeklappten Schlüssel exportiert) oder das falsche Zertifikat.
- **Notarisierung fehlgeschlagen:** Das Protokoll steht im Log des Schritts „Notarisieren“ (der
  Workflow ruft `notarytool log` selbst auf). Von Hand mit der Submission-ID:

  ```bash
  xcrun notarytool log <ID> --key AuthKey_XXXX.p8 --key-id <KEY_ID> --issuer <ISSUER_ID>
  ```

  Häufig: fehlende Hardened Runtime oder unsignierte verschachtelte Binärdateien.
- **App startet nicht, „beschädigt“:** Profil fehlt im Bundle oder passt nicht zur App-ID oder zum
  Zertifikat. Prüfen: `codesign -d --entitlements - Freiraum.app` und
  `security cms -D -i Freiraum.app/Contents/embedded.provisionprofile`.
- **Update wird nicht gefunden oder nicht installiert:** Sparkle in der Sandbox. Prüfen:
  `SUEnableInstallerLauncherService = YES` in der Info.plist, in den Entitlements die
  mach-lookup-Ausnahmen `<Bundle-ID>-spks` und `<Bundle-ID>-spki`, `SUFeedURL` und
  `SUPublicEDKey` nicht leer. Die Konsole (Prozess Freiraum, Stichwort „Sparkle“) nennt den Grund.
  Zeigt `releases/latest/download/appcast.xml` auf 404, ist „latest“ ein anderer Release
  (siehe Wartung).
- **Lokaler Build bietet keine Updates an:** gewollt, `FREIRAUM_UPDATE_FEED` ist leer.
