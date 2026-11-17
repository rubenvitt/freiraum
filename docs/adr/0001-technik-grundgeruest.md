# ADR 0001: Technik des Grundgerüsts (E0)

Stand: 17.11.2026 · Status: vorgeschlagen (mit FREI-1) · Ersetzt: den Abschnitt „Technik (Vorschlag)“ der Spec

## Kontext

Die Spec lässt Backend-Sprache, API-Vertrag und Anmeldung für E0 offen. Es gibt zwei Nutzer,
beide mit iPhone; später kommen macOS und Web dazu. Das Backend läuft auf dem Homelab (ARM64).
Das Repo ist öffentlich.

## Entscheidungen

### Backend: TypeScript, Hono, PostgreSQL

- **Node.js 22 + TypeScript**, Web-Framework **Hono**, Datenbank **PostgreSQL 16**.
- Datenbankzugriff mit **postgres.js** und handgeschriebenem SQL, Migrationen als nummerierte
  `.sql`-Dateien (`backend/migrations/`). Kein ORM: Die Invarianten aus der Spec
  (Summe der Aufteilungen, „Noch ohne Aufgabe ≥ 0“) sollen als Constraints und Transaktionen
  sichtbar bleiben.
- Beträge später als `bigint` in Cent.

Verworfen: **Swift/Vapor**. Ein gemeinsamer Sprachstack mit den Apps wäre schön, aber der
OpenAPI-Vertrag nimmt den größten Teil dieses Vorteils schon vorweg, und für Bankanbindung
(FinTS, PSD2-SDKs) und LLM-Anbindung ist das TypeScript-Ökosystem deutlich breiter.

### API-Vertrag: OpenAPI 3.1, aus dem Code erzeugt und versioniert

- Routen werden mit `@hono/zod-openapi` beschrieben; dieselben Zod-Schemas prüfen die Anfragen.
- `pnpm openapi` schreibt `openapi/openapi.yaml`. Die Datei ist versioniert und **der Vertrag**
  für die Clients (`swift-openapi-generator`, später Web).
- Ein Test schlägt fehl, wenn Code und Datei auseinanderlaufen. Änderungen am Vertrag sind damit
  im PR-Diff sichtbar.

Verworfen: Vertrag zuerst von Hand schreiben und Server dagegen prüfen. Doppelte Pflege ohne
Mehrwert bei einem einzigen Server.

### Anmeldung: Passkeys mit Einladung

- Nur **Passkeys** (WebAuthn), keine Passwörter. Funktioniert auf iPhone und Mac über
  `ASAuthorizationPlatformPublicKeyCredentialProvider` (Associated Domains, `webcredentials`) und
  im Browser für E6.
- **Kein Sign-up.** Personen und Einladungen entstehen nur per Kommandozeile auf dem Server
  (`node dist/cli.js person-anlegen …`). Eine Einladung ist ein einmaliges Token mit Ablauf;
  dieselbe Mechanik dient für weitere Geräte und zur Wiederherstellung.
- Auffindbare Passkeys (`residentKey: required`), Nutzerverifikation Pflicht (Face ID / Touch ID).
- Challenges liegen serverseitig, sind an Zweck (und bei der Registrierung an die Einladung)
  gebunden, laufen nach 5 Minuten ab und werden beim ersten Prüfversuch verbraucht.
- Nach erfolgreicher Prüfung gibt es ein **Bearer-Token** (`frs_…`), gespeichert nur als
  SHA-256-Hash. Gleitender Ablauf (Standard 90 Tage ab letzter Nutzung). Für das Web kann später
  ein Cookie mit demselben Sitzungsmodell dazukommen.

Verworfen: **Sign in with Apple**. Braucht für jede Plattform zusätzliche Einrichtung, bindet die
Identität an Apple-IDs und hilft im Browser nicht. Passkeys sind ohnehin über iCloud-Schlüsselbund
auf beiden Geräten einer Person verfügbar.

### Betrieb: Container auf dem Homelab

- Multi-Arch-Image (`linux/arm64`, `linux/amd64`) wird bei jedem Push auf `main` nach
  `ghcr.io/rubenvitt/freiraum-backend` gebaut.
- `deploy/compose.yaml` startet PostgreSQL und Backend; TLS macht der vorhandene Reverse Proxy.
  Migrationen laufen beim Start (Advisory Lock gegen Doppelstarts).
- Konfiguration und Secrets nur über Umgebungsvariablen (`deploy/.env`, nicht im Repo).

## Folgen

- Swift-Client wird in E3 aus `openapi/openapi.yaml` generiert.
- Wer die API ändert, führt `pnpm openapi` aus und committet die Datei mit.
- Passkeys brauchen eine feste HTTPS-Domain: `WEBAUTHN_RP_ID` darf sich nach der ersten
  Registrierung nicht mehr ändern, sonst sind alle Passkeys ungültig.
