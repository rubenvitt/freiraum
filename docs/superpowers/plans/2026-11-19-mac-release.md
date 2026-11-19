# Mac-Release und automatische Updates – Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jeder passende Merge auf `main` erzeugt einen signierten, notarisierten Mac-Release mit
Sparkle-Feed; die installierte App aktualisiert sich selbst.

**Architecture:** Ein neuer Workflow `.github/workflows/mac-release.yml` baut auf `macos-26`,
signiert mit Developer ID, notarisiert, signiert das DMG für Sparkle und legt einen GitHub-Release
an. Die App bindet Sparkle 2 nur unter macOS ein; ohne Feed-URL (lokale Builds) bleibt der
Updater aus. Testbare Logik liegt in FreiraumKit bzw. in Shell-Skripten unter `apple/scripts/`.

**Tech Stack:** GitHub Actions, Xcode/xcodebuild, XcodeGen, notarytool, Sparkle 2 (SPM), Bash,
Swift 6 (FreiraumKit, Swift Testing wie im Paket vorhanden).

**Spec:** `docs/superpowers/specs/2026-11-19-mac-release-design.md`

## Global Constraints

- Öffentliches Repo: keine Secrets, keine echte Domain/Team-ID im Code. Persönliches nur über
  GitHub-Variablen/Secrets bzw. `Local.xcconfig`.
- Release-Auslöser: Push auf `main` mit Pfaden `apple/**`, `openapi/**`,
  `.github/workflows/mac-release.yml`; dazu `workflow_dispatch` mit `dry_run` (boolean, Standard `true`).
- Version: `MARKETING_VERSION` in `project.yml` = `"0.1"`; CI setzt
  `MARKETING_VERSION=0.1.<run_number>` und `CURRENT_PROJECT_VERSION=<run_number>`.
- Tag `macos-v<Version>`, Titel `Freiraum für Mac <Version>`, Assets `Freiraum.dmg`, `appcast.xml`.
- Feed-URL im Release-Build: `https://github.com/rubenvitt/freiraum/releases/latest/download/appcast.xml`.
- Andere Releases im Repo müssen `--latest=false` nutzen (Kommentar im Workflow, ADR 0007).
- Fehlen alle Signatur-Secrets: `::warning::`, kein Release, Job grün. Fehlt nur ein Teil: Fehler.
- Variablen: `APPLE_TEAM_ID`, `FREIRAUM_BUNDLE_PREFIX`, `FREIRAUM_DOMAIN`, `SPARKLE_PUBLIC_KEY`.
  Secrets: `MACOS_CERTIFICATE_P12`, `MACOS_CERTIFICATE_PASSWORD`, `MACOS_PROVISIONING_PROFILE`,
  `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`, `SPARKLE_PRIVATE_KEY`.
- Sparkle-Info.plist: `SUFeedURL=$(FREIRAUM_UPDATE_FEED)`, `SUPublicEDKey=$(FREIRAUM_SPARKLE_PUBLIC_KEY)`,
  `SUEnableAutomaticChecks=YES`, `SUAutomaticallyUpdate=YES`, `SUScheduledCheckInterval=3600`,
  `SUEnableInstallerLauncherService=YES`. `minimumSystemVersion` im Appcast: `26.0`.
- Texte deutsch, wie im Rest der App („Nach Updates suchen …“).

## Review Focus

1. Lokaler Build ohne `FREIRAUM_UPDATE_FEED` → kein Updater, kein Menüpunkt (Task 1 testet die Entscheidung).
2. Teilweise gesetzte Secrets → harter Fehler mit Namen der fehlenden; keine gesetzt → Warnung, grün (Task 3 testet das Skript).
3. Appcast mit Sonderzeichen in Notes/URL bleibt gültiges XML; Länge und Signatur landen exakt im Enclosure (Task 2).
4. `run_number`-Version steigt immer, auch nach Wechsel `0.1` → `0.2` (Task 3: Version aus Skript).
5. Dry-Run auf einem Branch legt nie einen Release an (Task 4, Bedingung am Release-Schritt).

---

### Task 1: Versionen und Update-Entscheidung

**Files:**
- Modify: `apple/project.yml` (MARKETING_VERSION `"0.1"`, info.properties `CFBundleShortVersionString: $(MARKETING_VERSION)`, `CFBundleVersion: $(CURRENT_PROJECT_VERSION)`)
- Modify: `apple/Freiraum/Info.plist` (gleiche Werte, damit Datei und project.yml übereinstimmen)
- Create: `apple/FreiraumKit/Sources/FreiraumKit/UpdateFeed.swift`
- Test: `apple/FreiraumKit/Tests/FreiraumKitTests/UpdateFeedTests.swift`

**Interfaces:**
- Produces: `public enum UpdateFeed { public static func url(from raw: String?) -> URL? }` –
  `nil` bei `nil`, leer/Whitespace, nicht-https, unaufgelöster Variable (`$(` am Anfang); sonst die URL.

- [ ] Test schreiben: `nil`, `""`, `"  "`, `"$(FREIRAUM_UPDATE_FEED)"`, `"http://x/appcast.xml"` → `nil`;
  `"https://github.com/rubenvitt/freiraum/releases/latest/download/appcast.xml"` → diese URL.
- [ ] Rot sehen: `docker run --rm -v "$PWD":/src -w /src/apple/FreiraumKit swift:6.1-noble swift test --filter UpdateFeed`
- [ ] `UpdateFeed.url(from:)` implementieren; Version in `project.yml`/`Info.plist` umstellen.
- [ ] Grün sehen (gleicher Befehl, dann ganzes `swift test`).
- [ ] Commit.

### Task 2: Appcast-Skript

**Files:**
- Create: `apple/scripts/appcast.sh`
- Test: `apple/scripts/test-appcast.sh`

**Interfaces:**
- Produces: `appcast.sh --version 0.1.57 --build 57 --url <dmg-url> --length <bytes> --signature <ed-sig> --notes-url <release-url> > appcast.xml`.
  Ausgabe: RSS 2.0 mit Namespace `xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"`,
  ein `<item>` mit `<title>Freiraum <Version></title>`, `<sparkle:version>` = build,
  `<sparkle:shortVersionString>` = version, `<sparkle:minimumSystemVersion>26.0</…>`,
  `<sparkle:fullReleaseNotesLink>`, `<pubDate>` (RFC 822), `<enclosure url length type="application/octet-stream" sparkle:edSignature>`.
  Fehlendes Argument → Exit 2 mit Meldung. Werte XML-escaped (`&`, `<`, `>`, `"`).

- [ ] Test schreiben (Bash): erzeugt Appcast, prüft mit `xmllint --noout`, prüft per `xmllint --xpath`
  Version, Build, Länge, Signatur, URL; Fall mit `&` in der Notes-URL bleibt gültig; fehlendes `--signature` → Exit 2.
- [ ] Rot sehen: `bash apple/scripts/test-appcast.sh`
- [ ] Skript implementieren (`set -euo pipefail`, Heredoc).
- [ ] Grün sehen. Commit.

### Task 3: Release-Hilfsskripte (Secrets prüfen, Version)

**Files:**
- Create: `apple/scripts/release-env.sh`
- Test: `apple/scripts/test-release-env.sh`

**Interfaces:**
- Produces:
  - `release-env.sh check` – liest die 7 Secrets und 4 Variablen aus der Umgebung (Namen oben).
    Alle Secrets leer → schreibt `::warning::…` und `enabled=false` nach `$GITHUB_OUTPUT`, Exit 0.
    Alle gesetzt → `enabled=true`, Exit 0. Teilweise → `::error::Es fehlen: <Namen>`, Exit 1.
    Fehlende Variablen bei gesetzten Secrets ebenfalls Fehler.
  - `release-env.sh version <project.yml> <run_number>` – gibt `0.1.<run_number>` aus (Major.Minor
    aus `MARKETING_VERSION` in project.yml; akzeptiert auch `"0.2"`).

- [ ] Test schreiben: drei Fälle für `check` (keine/alle/teilweise, `GITHUB_OUTPUT` auf Temp-Datei),
  `version` mit `"0.1"` → `0.1.57`, mit `"0.2"` → `0.2.58`.
- [ ] Rot sehen: `bash apple/scripts/test-release-env.sh`
- [ ] Implementieren. Grün sehen. Commit.

### Task 4: Workflow `mac-release.yml`

**Files:**
- Create: `.github/workflows/mac-release.yml`
- Create: `apple/Config/ExportOptions.plist` (method `developer-id`, signingStyle `manual`,
  `provisioningProfiles` wird zur Laufzeit per `plutil` gesetzt)

**Interfaces:**
- Consumes: `release-env.sh check|version`, `appcast.sh`, Variablen/Secrets aus Global Constraints.

Ablauf (Reihenfolge fest, Umsetzung frei):
1. Job `kit` (ubuntu, `swift:6.1-noble`): `swift test` in `apple/FreiraumKit`; zusätzlich
   `bash apple/scripts/test-appcast.sh` und `bash apple/scripts/test-release-env.sh`.
2. Job `release` (`macos-26`, needs kit, `concurrency: {group: mac-release, cancel-in-progress: false}`,
   `permissions: contents: write`):
   `check` → bei `enabled=false` alle weiteren Schritte überspringen.
   Temporärer Schlüsselbund + P12-Import; Profil nach `~/Library/MobileDevice/Provisioning Profiles/`,
   UUID/Name per `security cms -D` lesen. `Local.xcconfig` aus Variablen schreiben, zusätzlich
   `FREIRAUM_UPDATE_FEED`, `FREIRAUM_SPARKLE_PUBLIC_KEY`, `CODE_SIGN_STYLE = Manual`,
   `CODE_SIGN_IDENTITY = Developer ID Application`, `PROVISIONING_PROFILE_SPECIFIER`.
   `brew install xcodegen && xcodegen generate`. `xcodebuild archive` (Scheme Freiraum,
   `-destination 'generic/platform=macOS'`, `MARKETING_VERSION`, `CURRENT_PROJECT_VERSION`,
   `-skipPackagePluginValidation`). `-exportArchive`. DMG per `hdiutil create -format UDZO` mit
   Symlink `/Applications`. `notarytool submit --wait` (Key aus `ASC_KEY_P8` in Temp-Datei),
   `stapler staple`. Sparkle `sign_update` aus dem SPM-Checkout (`SourcePackages/artifacts/sparkle/Sparkle/bin/sign_update`)
   mit `--ed-key-file` → Signatur und Länge. `appcast.sh`. Bei `dry_run`: `actions/upload-artifact`
   mit DMG und Appcast, kein Release. Sonst `gh release create macos-v<Version> --title … --generate-notes --latest Freiraum.dmg appcast.xml`.
   Release-Schritt nur, wenn `github.ref == 'refs/heads/main'` und nicht `dry_run`.
   Aufräumen (`if: always()`): Schlüsselbund, Profil, Key-Dateien löschen.
3. Kommentar oben: „Andere Releases in diesem Repo mit --latest=false anlegen …“.

- [ ] Workflow schreiben.
- [ ] Prüfen: `docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest -color` → keine Befunde.
- [ ] Commit.

### Task 5: Sparkle in der App

**Files:**
- Modify: `apple/project.yml` (Paket `Sparkle: {url: https://github.com/sparkle-project/Sparkle, from: 2.6.0}`,
  Abhängigkeit am Ziel Freiraum mit `destinationFilters: [macOS]`, Info-Properties aus Global Constraints)
- Modify: `apple/Freiraum/Info.plist` (gleiche Schlüssel)
- Modify: `apple/Config/Freiraum.xcconfig` (`FREIRAUM_UPDATE_FEED =`, `FREIRAUM_SPARKLE_PUBLIC_KEY =`)
- Modify: `apple/Freiraum/Freiraum-macOS.entitlements` (`com.apple.security.temporary-exception.mach-lookup.global-name`:
  `$(PRODUCT_BUNDLE_IDENTIFIER)-spks`, `$(PRODUCT_BUNDLE_IDENTIFIER)-spki`)
- Create: `apple/Freiraum/App/Updater.swift`
- Modify: `apple/Freiraum/App/FreiraumApp.swift` (`.commands { CommandGroup(after: .appInfo) { … } }`)
- Modify: `apple/Freiraum/Views/Mac/MenuBarView.swift` (Eintrag „Nach Updates suchen …“, nur wenn aktiv)

**Interfaces:**
- Consumes: `UpdateFeed.url(from:)` (Task 1).
- Produces: `@MainActor final class Updater` (nur `#if os(macOS) && canImport(Sparkle)`):
  `static let shared`, `var isAvailable: Bool` (Feed vorhanden), `var canCheck: Bool` (beobachtbar,
  aus `SPUUpdater.canCheckForUpdates`), `func checkForUpdates()`. Startet
  `SPUStandardUpdaterController(startingUpdater: true, …)` nur, wenn
  `UpdateFeed.url(from: Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String) != nil`.

- [ ] Umsetzen.
- [ ] Prüfen hier: `swift test` (Kit) grün; `xmllint --noout` auf Info.plist und Entitlements.
  Den macOS-Build prüft der Apple-Workflow im PR (`xcodebuild … CODE_SIGNING_ALLOWED=NO`); muss grün werden.
- [ ] Commit.

### Task 6: Dokumentation

**Files:**
- Create: `docs/adr/0007-mac-releases.md` (Format wie ADR 0004: Kontext, Entscheidungen, Folgen; Inhalt aus der Spec, inkl. `--latest=false`-Regel)
- Create: `apple/RELEASE.md` (Einrichtung Schritt 1–6 aus der Spec, Liste Variablen/Secrets mit Erzeugung je Wert, Base64-Befehle `base64 -i … | pbcopy`, `generate_keys`, Zertifikatsablauf, Dry-Run-Ablauf)
- Modify: `apple/README.md` (Abschnitt „Mac-App installieren“ mit Download-Link, Hinweis Updates)
- Modify: `README.md` (Download-Link; Status um ADR 0007 ergänzen)

- [ ] Schreiben. Commit.
