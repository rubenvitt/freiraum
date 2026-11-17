# Freiraum

Persönliches Finanz-Cockpit für Paare: Budget nach dem Topf-Prinzip, getrennte und gemeinsame Konten, Auswertungen wie „Woher kommt mein Geld, wohin fließt es?“, und möglichst wenig Pflegeaufwand.

- Spec: [`docs/superpowers/specs/2026-11-17-freiraum-design.md`](docs/superpowers/specs/2026-11-17-freiraum-design.md)
- Plattformen: Backend (selbst gehostet), iOS und macOS (SwiftUI), später Web

## Aufbau

- `backend/`: API-Server (TypeScript, Hono, PostgreSQL), siehe [`backend/README.md`](backend/README.md)
- `openapi/openapi.yaml`: API-Vertrag für alle Clients (aus dem Backend erzeugt)
- `deploy/`: Compose-Datei und Anleitung fürs Homelab
- `docs/adr/`: Architekturentscheidungen

Status: E0 Grundgerüst (Backend-Skelett, Anmeldung per Passkey).
