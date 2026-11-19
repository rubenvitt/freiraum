# ADR 0007: Mac-Releases und Updates

Stand: 19.11.2026 · Status: vorgeschlagen

## Kontext

Die Mac-App baute bisher nur unsigniert in der CI. Wer sie benutzen wollte, musste sie selbst in
Xcode bauen. Ziel: herunterladen, installieren, danach nie wieder von Hand aktualisieren. Jeder
Merge auf `main`, der die App betrifft, soll ohne weiteren Handgriff beim Nutzer ankommen.
Das Repo ist öffentlich, also auch die Releases. Die App ist sandboxed, mit Hardened Runtime,
macOS 26. Spec: `docs/superpowers/specs/2026-11-19-mac-release-design.md`.

## Entscheidungen

### Versionierung: fortlaufende Nummer

- `MARKETING_VERSION` in `apple/project.yml` hält nur `Major.Minor` (`0.1`). Die CI hängt
  `github.run_number` an (`0.1.57`); `CFBundleVersion` ist `run_number`. Sparkle vergleicht danach.
  Von `0.1` auf `0.2` erhöht man von Hand.
- Verworfen: Conventional Commits mit release-please (ohne Präfix kein Release, passt nicht zu
  deutschen Commit-Texten) und Labels am PR (Handarbeit).
- Ein Release entsteht nur bei Änderungen an `apple/**` (ohne reine `.md`-Dateien), `openapi/**` oder am Workflow. Ein reiner
  Backend-Merge ergäbe sonst ein identisches „Update“.

### Ort: öffentliche GitHub-Releases

- Tag `macos-v<Version>`, Titel „Freiraum für Mac <Version>“, Assets `Freiraum.dmg` und
  `appcast.xml`, Notizen aus den gemergten PRs.
- Domain, Team-ID und Bundle-ID werden dadurch öffentlich. Vertretbar: Die Domain steht ohnehin
  in DNS und Zertifikatslogs, Schutz geben die Passkeys.
- Verworfen: privates Release-Repo (Sparkle bräuchte Zugangsdaten) und Auslieferung über den
  Server (viel Backend-Arbeit, Download hängt am Homelab).
- Fester Download-Link: `https://github.com/rubenvitt/freiraum/releases/latest/download/Freiraum.dmg`.

### Workflow `.github/workflows/mac-release.yml`

- Auslöser: Push auf `main` mit Pfadfilter, dazu `workflow_dispatch` mit `dry_run` (Standard
  `true`). Der Probelauf baut, signiert und notarisiert, lädt das DMG als Artefakt hoch und legt
  keinen Release an.
- `concurrency: mac-release` ohne Abbrechen: Pro Gruppe läuft einer, höchstens einer wartet (siehe Folgen).
- Job 1 (Linux): `swift test` für FreiraumKit und die Skript-Tests. Ohne grüne Tests kein Release.
- Job 2 (`macos-26`): temporärer Schlüsselbund mit Zertifikat „Developer ID Application“,
  Provisioning-Profil, `Local.xcconfig` aus Variablen, `xcodegen generate`, `xcodebuild archive`
  und `-exportArchive` (`developer-id`), DMG, Notarisierung mit `notarytool` und
  App-Store-Connect-API-Schlüssel, `stapler staple`, EdDSA-Signatur mit Sparkles `sign_update`,
  Appcast, Release. Schlüsselbund, Profil und Schlüsseldateien werden am Ende immer entfernt.
- Fehlen alle Signatur-Secrets, endet der Job mit Warnung und ohne Release (grün), damit `main`
  grün bleibt, solange die Einrichtung aussteht. Fehlt nur ein Teil, bricht er mit klarer Meldung ab.
- Persönliche Werte (Variablen `APPLE_TEAM_ID`, `FREIRAUM_BUNDLE_PREFIX`, `FREIRAUM_DOMAIN`,
  `SPARKLE_PUBLIC_KEY`) und Secrets liegen in GitHub, nicht im Repo. Liste und Herkunft:
  [`apple/RELEASE.md`](../../apple/RELEASE.md).

### Updates: Sparkle 2

- Paket nur für macOS, Code hinter `#if os(macOS)`. Die App prüft stündlich im Hintergrund, lädt
  neue Versionen und installiert sie beim nächsten Beenden. Menüpunkt „Nach Updates suchen …“.
- Sandbox: `SUEnableInstallerLauncherService = YES` und mach-lookup-Ausnahmen für
  `$(PRODUCT_BUNDLE_IDENTIFIER)-spks` und `-spki`. Der Downloader-Dienst entfällt, Netzzugriff
  hat die App schon.
- Lokale Builds aktualisieren sich nicht: `FREIRAUM_UPDATE_FEED` ist dort leer, dann startet die
  App den Updater nicht und blendet den Menüpunkt aus. Nur die CI setzt Feed und öffentlichen
  Schlüssel.
- Der Appcast (`apple/scripts/appcast.sh`) enthält genau einen Eintrag (`minimumSystemVersion`
  26.0). Das genügt, weil Sparkle immer auf die neueste Version springt. Ohne Delta-Updates.

### Regel: andere Releases mit `--latest=false`

Der Feed liegt unter `releases/latest/download/appcast.xml`. „Latest“ gilt für das ganze Repo.
Jeder andere Release (z. B. später für iOS) **muss** mit `--latest=false` angelegt werden
(`gh release create … --latest=false`). Sonst zeigt „latest“ auf einen Release ohne `appcast.xml`,
und installierte Apps finden keine Updates mehr. Die Regel steht auch als Kommentar im Workflow.
Alternative wäre ein fester Feed über GitHub Pages. Heute erzeugt nichts sonst Releases.

## Folgen

- Prüfen lässt sich die signierte Kette nur in der CI auf macOS. Der Probelauf (`dry_run`) ist der
  erste echte Test.
- Associated Domains brauchen bei Developer-ID-Apps das Provisioning-Profil im Bundle; es läuft
  ab und muss erneuert werden. Das Zertifikat gilt 5 Jahre.
- Sparkle in der Sandbox ist eine häufige Fehlerquelle (Installer-Dienst, Entitlements).
- Der Server braucht weiter `APPLE_APP_IDS` (siehe [ADR 0004](0004-ios-app.md)).
- Actions-Logs sind öffentlich, und `xcodebuild` zeigt dort weiterhin Signaturname, Team-ID und
  Profil. Akzeptiert, wie der Release selbst; der Workflow gibt darüber hinaus nichts Persönliches aus.
- Angeheftet (stapled) wird nur das DMG, nicht die App darin. Der erste Start offline nach dem
  Kopieren braucht eine Online-Prüfung durch Gatekeeper.
- Die Concurrency-Gruppe behält nur einen wartenden Lauf: Bei mehreren schnellen Merges entfallen
  die mittleren Läufe, der neueste gewinnt.
- Updates werden beim Beenden installiert. Weil die App im Menüleistensymbol weiterläuft, kann ein
  Update bis zum nächsten Beenden oder Neustart warten.
- Nicht enthalten: iOS/TestFlight, Delta-Updates, Beta-Kanal, Mac App Store.
