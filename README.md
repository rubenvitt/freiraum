# Freiraum

Persönliches Finanz-Cockpit für Paare: Budget nach dem Topf-Prinzip, getrennte und gemeinsame Konten, Auswertungen wie „Woher kommt mein Geld, wohin fließt es?“, und möglichst wenig Pflegeaufwand.

- Spec: [`docs/superpowers/specs/2026-11-17-freiraum-design.md`](docs/superpowers/specs/2026-11-17-freiraum-design.md)
- Mac-App: [Freiraum.dmg laden](https://github.com/rubenvitt/freiraum/releases/latest/download/Freiraum.dmg), aktualisiert sich selbst
- Plattformen: Backend (selbst gehostet), iOS und macOS (SwiftUI), später Web

## Aufbau

- `backend/`: API-Server (TypeScript, Hono, PostgreSQL), siehe [`backend/README.md`](backend/README.md)
- `openapi/openapi.yaml`: API-Vertrag für alle Clients (aus dem Backend erzeugt)
- `apple/`: iOS- und macOS-App mit Widget (SwiftUI), siehe [`apple/README.md`](apple/README.md)
- `deploy/`: Compose-Datei und Anleitung fürs Homelab
- `docs/adr/`: Architekturentscheidungen

Status: E0 Grundgerüst (Backend-Skelett, Anmeldung per Passkey) steht. E1: Haushalte, Konten, idempotenter Import, Erkennung wiederkehrender Buchungen; Bankanbindung über Enable Banking, siehe [ADR 0002](docs/adr/0002-bankanbindung.md). E2: Töpfe, Zuweisungen, Monatsabschluss, Erst-ich-Automatik und Kategorisierung (Regeln, LLM-Schnittstelle), siehe [ADR 0003](docs/adr/0003-budget-kern.md). E3: iOS-App mit Übersicht, Bestätigen, Barausgabe, Widget und Benachrichtigung, siehe [ADR 0004](docs/adr/0004-ios-app.md). Mac-Releases mit automatischen Updates bei jedem Merge, siehe [ADR 0007](docs/adr/0007-mac-releases.md).
