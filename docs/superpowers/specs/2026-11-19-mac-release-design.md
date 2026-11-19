# Mac-App: Release bei jedem Merge und automatische Updates

Stand: 19.11.2026 · Teil 1 von 3 (danach: Ersteinrichtung am Server, Onboarding in der App)

## Warum

Ruben hat die Mac-App noch nie benutzt: Sie baut bisher nur unsigniert in der CI, und ohne
eigenes Bauen in Xcode kommt man nicht an sie heran. Ziel ist, die App wie jede andere Mac-App
herunterzuladen, zu installieren und danach nie wieder von Hand zu aktualisieren. Jeder Merge auf
`main`, der die App betrifft, landet ohne weiteren Handgriff beim Nutzer.

## Ziele

- Jeder Push auf `main`, der `apple/**` oder `openapi/**` (oder den Release-Workflow) ändert,
  erzeugt automatisch einen GitHub-Release mit signierter, notarisierter macOS-App.
- Fester Download-Link für die jeweils neueste Version:
  `https://github.com/rubenvitt/freiraum/releases/latest/download/Freiraum.dmg`.
- Die installierte App aktualisiert sich selbst (Sparkle): prüft im Hintergrund, lädt neue
  Versionen herunter und installiert sie beim nächsten Beenden. Dazu ein Menüpunkt
  „Nach Updates suchen …“.
- Anmeldung per Passkey funktioniert in der heruntergeladenen App (Associated Domain eingebaut).

## Nicht-Ziele

- iOS/TestFlight (bleibt wie bisher: lokal bauen).
- Ersteinrichtung des Servers, Onboarding, Einführung (Teil 2 und 3).
- `APPLE_APP_IDS` im Server-Image vorbelegen (Teil 2). Bis dahin setzt Ruben die Variable wie
  heute in `deploy/.env`.
- Delta-Updates, Beta-Kanal, Mac App Store.

## Anti-Ziele

- Kein Release darf ohne Zutun hängen bleiben, weil jemand ein Commit-Präfix vergessen hat.
- Lokale Entwickler-Builds dürfen sich nicht selbst durch Release-Versionen ersetzen.
- Keine Secrets im Repo oder in Logs (öffentliches Repo). Domain, Team-ID und Bundle-ID werden
  durch die Releases öffentlich; das ist bewusst so entschieden (siehe unten).

## Rahmen

- Repo ist öffentlich, also auch die Releases.
- App ist sandboxed, Hardened Runtime an, macOS 26, XcodeGen (`apple/project.yml`).
- Persönliche Werte kommen heute aus `apple/Config/Local.xcconfig` (nicht im Repo).
- Ruben hat ein bezahltes Apple-Developer-Konto. Einrichtung im Developer-Portal und das Eintragen
  der GitHub-Secrets kann Claude per Computer Use auf Rubens Rechner übernehmen.

## Ansätze

**Versionierung**

- **A. Fortlaufende Nummer (gewählt).** `MARKETING_VERSION` in `project.yml` hält nur
  `Major.Minor` (z. B. `0.1`), die CI hängt `github.run_number` an → `0.1.57`;
  `CFBundleVersion` = `run_number` (steigt immer, Sparkle vergleicht danach). Release-Notes aus den
  Titeln der gemergten PRs. Nichts kann vergessen werden.
- B. Conventional Commits mit release-please/semantic-release: Versionen mit Bedeutung, aber ohne
  Präfix kein Release, und passt nicht zu den deutschen Commit-Texten. Verworfen.
- C. Labels am PR: Handarbeit an jedem PR. Verworfen.

Ein Release entsteht nur bei Änderungen an `apple/**`, `openapi/**` oder am Workflow selbst; ein
reiner Backend-Merge ergäbe sonst ein identisches „Update“ (von Ruben bestätigt).

**Ort der Releases**

- **A. Öffentliche GitHub-Releases (gewählt).** Die eingebaute Domain, Team-ID und Bundle-ID
  sind damit öffentlich. Vertretbar: Die Domain steht ohnehin in DNS und Zertifikatslogs, Schutz
  geben die Passkeys.
- B. Privates Release-Repo: Sparkle bräuchte Zugangsdaten. Verworfen.
- C. Server liefert Updates selbst: viel Backend-Arbeit, Download hängt am Homelab. Verworfen.

**Update-Mechanismus:** Sparkle 2 (Standard außerhalb des App Stores). Von Ruben bestätigt.

## Entscheidungen

### Workflow `.github/workflows/mac-release.yml`

- Auslöser: `push` auf `main` mit Pfadfilter `apple/**`, `openapi/**`,
  `.github/workflows/mac-release.yml`; dazu `workflow_dispatch` mit Eingabe `dry_run`
  (Standard `true`): baut, signiert und notarisiert auf einem beliebigen Branch, lädt das DMG als
  Workflow-Artefakt hoch, legt aber keinen Release an. So lässt sich die Einrichtung vor dem
  ersten Merge prüfen.
- `concurrency: mac-release` (ohne Abbrechen), damit Releases nacheinander entstehen.
- Job 1 (Linux): `swift test` in `apple/FreiraumKit` wie im Apple-Workflow. Ohne grüne Tests
  kein Release.
- Job 2 (`macos-26`):
  1. Fehlen die Signatur-Secrets ganz, endet der Job mit einer Warnung (`::warning::`) und ohne
     Release, statt rot zu werden; so bleibt `main` grün, solange die Einrichtung noch aussteht.
     Fehlt nur ein Teil davon, bricht er mit klarer Meldung ab. (Claudes Entscheidung.)
  2. Zertifikat in einen temporären Schlüsselbund, Provisioning-Profil installieren.
  3. `Local.xcconfig` aus Variablen erzeugen, Version setzen, `xcodegen generate`.
  4. `xcodebuild archive` (Release, macOS, manuelle Signatur mit „Developer ID Application“ und
     dem Profil) → `xcodebuild -exportArchive` mit `method: developer-id`.
  5. DMG bauen (`hdiutil`, App + Verknüpfung zu „Programme“), Name `Freiraum.dmg`.
  6. Notarisieren (`xcrun notarytool submit --wait` mit App-Store-Connect-API-Schlüssel),
     `xcrun stapler staple` auf das DMG.
  7. DMG mit Sparkle `sign_update` signieren (EdDSA), `appcast.xml` erzeugen.
  8. Release anlegen: Tag `macos-v<Version>`, Titel „Freiraum für Mac <Version>“,
     `--generate-notes`, Assets `Freiraum.dmg` und `appcast.xml`. Als „latest“ markiert.
  9. Schlüsselbund und Profil am Ende immer entfernen.
- Die bisherige `apple.yml` bleibt unverändert (PR-Prüfung ohne Signatur).

### Versionen

- `project.yml`: `MARKETING_VERSION: "0.1"`. Die CI setzt `MARKETING_VERSION=0.1.<run_number>`
  und `CURRENT_PROJECT_VERSION=<run_number>` als Build-Einstellungen. Ruben erhöht `0.1` → `0.2`
  von Hand, wenn ihm danach ist.
- `Info.plist` entsteht aus `project.yml` (`info.properties`); dort `CFBundleShortVersionString:
  $(MARKETING_VERSION)` und `CFBundleVersion: $(CURRENT_PROJECT_VERSION)` eintragen (heute landen
  feste Werte `1.0`/`1` in der Datei). `MARKETING_VERSION` wird von `0.1.0` auf `0.1` gekürzt.
- Lokale Builds behalten `0.1` und Build `1`.

### Sparkle in der App

- Paket `https://github.com/sparkle-project/Sparkle` (Version 2.x), nur für macOS
  (`destinationFilters: [macOS]`); Code hinter `#if os(macOS)`.
- `SPUStandardUpdaterController` im App-Start, Menüpunkt „Nach Updates suchen …“ im App-Menü
  (nach „Über Freiraum“) und in der Menüleisten-Ansicht.
- Info.plist (nur macOS-relevant): `SUFeedURL = $(FREIRAUM_UPDATE_FEED)`,
  `SUPublicEDKey = $(FREIRAUM_SPARKLE_PUBLIC_KEY)`, `SUEnableAutomaticChecks = YES`,
  `SUAutomaticallyUpdate = YES`, `SUScheduledCheckInterval = 3600`,
  `SUEnableInstallerLauncherService = YES`.
- Sandbox: Entitlement `com.apple.security.temporary-exception.mach-lookup.global-name` mit
  `$(PRODUCT_BUNDLE_IDENTIFIER)-spks` und `$(PRODUCT_BUNDLE_IDENTIFIER)-spki`
  (Sparkle-Installer-Dienste). Netzzugriff ist schon erlaubt, der Downloader-Dienst entfällt.
- **Lokale Builds aktualisieren sich nicht:** `FREIRAUM_UPDATE_FEED` ist in `Freiraum.xcconfig`
  leer; ist der Feed leer, startet die App den Updater nicht und blendet den Menüpunkt aus. Nur
  die CI setzt den Feed auf
  `https://github.com/rubenvitt/freiraum/releases/latest/download/appcast.xml`.

### Appcast

- Eine kleine Skriptdatei im Repo (z. B. `apple/scripts/appcast.sh`) erzeugt `appcast.xml` mit
  genau einem Eintrag: Version, Build, `minimumSystemVersion` 26.0, Enclosure-URL auf
  `releases/download/macos-v<Version>/Freiraum.dmg`, Länge, `sparkle:edSignature`,
  `sparkle:fullReleaseNotesLink` auf die Release-Seite. Ein Eintrag reicht, weil Sparkle immer auf
  die neueste Version springt.
- Feed-URL zeigt über `releases/latest/download/appcast.xml` immer auf den neuesten Release.
  „Latest“ gilt für das ganze Repo: Jeder andere Release (z. B. später iOS) **muss** mit
  `--latest=false` entstehen, sonst finden installierte Apps keine Updates mehr. Das steht in ADR
  0007 und als Kommentar im Workflow. Heute erzeugt nichts sonst Releases. (Claudes Entscheidung;
  Alternative wäre ein fester Feed über GitHub Pages.)

### Secrets und Variablen (GitHub, Repo-Ebene)

Variablen (nicht geheim, aber nicht im Repo-Code): `APPLE_TEAM_ID`, `FREIRAUM_BUNDLE_PREFIX`,
`FREIRAUM_DOMAIN`, `SPARKLE_PUBLIC_KEY`.

Secrets: `MACOS_CERTIFICATE_P12` (Base64), `MACOS_CERTIFICATE_PASSWORD`,
`MACOS_PROVISIONING_PROFILE` (Base64, Developer-ID-Profil der App-ID mit Associated Domains),
`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (App-Store-Connect-API-Schlüssel für die
Notarisierung), `SPARKLE_PRIVATE_KEY` (EdDSA).

### Einrichtung (einmalig, mit Ruben per Computer Use)

1. Developer-Portal: App-ID `<Präfix>.freiraum` mit Associated Domains (existiert evtl. schon),
   Zertifikat „Developer ID Application“ (CSR am Mac), Provisioning-Profil „Developer ID“ für die
   App-ID.
2. App Store Connect: API-Schlüssel (Rolle „Developer“) für `notarytool`.
3. Sparkle-Schlüssel am Mac mit `generate_keys` erzeugen; privater Teil nur ins GitHub-Secret.
4. Variablen und Secrets in GitHub eintragen; Werte gehen nie durch den Chat.
5. GitHub bietet den manuellen Start erst an, wenn der Workflow auf `main` liegt. Deshalb:
   PR mergen (der Lauf auf `main` endet mangels Secrets mit Warnung, kein Release), Secrets
   eintragen, `workflow_dispatch` mit `dry_run` auf `main`: DMG aus den Artefakten installieren,
   mit Passkey anmelden. Dann `workflow_dispatch` ohne `dry_run` für den ersten echten Release;
   ab da jeder passende Merge. (Claudes Entscheidung.)
6. Auf dem Server `APPLE_APP_IDS=<TEAMID>.<Präfix>.freiraum` (wie heute).

Eine Anleitung dazu kommt nach `apple/RELEASE.md`, inklusive „Zertifikat läuft ab“ (Developer ID
gilt 5 Jahre).

### Dokumentation

- ADR 0007 „Mac-Releases und Updates“ mit den Entscheidungen oben.
- `apple/README.md`: Abschnitt „Mac-App installieren“ mit dem festen Download-Link.
- `README.md` (Wurzel): Download-Link.

## Dem Builder überlassen

- Genaue Gestalt des Workflows (Actions, Schritte, Caching), solange die Reihenfolge oben gilt.
- Ob das Appcast-Skript Shell oder Swift ist; ob `generate_appcast` statt eigenem Skript genutzt
  wird, wenn das einfacher ist.
- Gestaltung des DMG (Hintergrundbild nicht nötig).
- Wo genau `SPUStandardUpdaterController` lebt (z. B. kleine `Updater`-Klasse in
  `Freiraum/App/`).

## Bekannte Risiken

- Prüfen lässt sich die signierte Kette nur in der CI auf macOS; in dieser Umgebung (Linux)
  läuft nur `swift test`. Der `dry_run` ist deshalb der erste echte Test.
- Sparkle in der Sandbox ist eine häufige Fehlerquelle (Installer-Dienste, Entitlements). Bei
  Problemen prüfen: `SUEnableInstallerLauncherService` und die mach-lookup-Ausnahmen.
- Associated Domains bei Developer-ID-Apps brauchen das Provisioning-Profil im Bundle
  (`embedded.provisionprofile`); ohne Profil startet die App nicht.
