# Freiraum-Backend

TypeScript, Hono, PostgreSQL. Entscheidungen: [`docs/adr/0001-technik-grundgeruest.md`](../docs/adr/0001-technik-grundgeruest.md).

## Lokal entwickeln

Voraussetzungen: Node.js 22, pnpm, PostgreSQL 16.

```bash
pnpm install
```

```bash
DATABASE_URL=postgres://freiraum:freiraum@localhost:5432/freiraum \
WEBAUTHN_RP_ID=localhost WEBAUTHN_ORIGINS=http://localhost:3000 \
pnpm dev
```

## Befehle

| Befehl | Zweck |
|---|---|
| `pnpm test` | Tests gegen echtes PostgreSQL (`TEST_DATABASE_URL`, Standard `postgres://freiraum:freiraum@localhost:5432/freiraum_test`; die Datenbank wird bei jedem Lauf neu angelegt) |
| `pnpm lint` / `pnpm format` | Biome |
| `pnpm typecheck` | TypeScript inkl. Tests |
| `pnpm openapi` | `../openapi/openapi.yaml` neu erzeugen, nach jeder API-Änderung |
| `pnpm cli <befehl>` | Verwaltung: `migrate`, `person-anlegen`, `einladen`, `personen`, `gemeinsam-anlegen` |

## Umgebungsvariablen

| Variable | Pflicht | Standard | Bedeutung |
|---|---|---|---|
| `DATABASE_URL` | ja | | PostgreSQL-Verbindung |
| `WEBAUTHN_RP_ID` | ja | | Domain der Passkeys, z. B. `freiraum.example.org` |
| `WEBAUTHN_ORIGINS` | nein | `https://<RP-ID>` | erlaubte Origins, mit Komma getrennt |
| `WEBAUTHN_RP_NAME` | nein | `Freiraum` | Anzeigename beim Passkey-Dialog |
| `APPLE_APP_IDS` | nein | | `TEAMID.bundle.id` für apple-app-site-association |
| `SESSION_TTL_DAYS` | nein | `90` | Ablauf einer Sitzung ab letzter Nutzung |
| `INVITATION_TTL_HOURS` | nein | `72` | Gültigkeit einer Einladung |
| `MIGRATE_ON_START` | nein | `true` | Migrationen beim Start anwenden |
| `PORT` | nein | `3000` | HTTP-Port |

## Anmeldung (Ablauf)

1. `POST /v1/auth/registration/options` mit Einladungs-Token → `challengeId` + WebAuthn-Optionen
2. Gerät erzeugt den Passkey → `POST /v1/auth/registration/verify` → Sitzung (`token`)
3. Später: `POST /v1/auth/login/options` → `POST /v1/auth/login/verify` → Sitzung
4. Alle weiteren Aufrufe mit `Authorization: Bearer <token>`

Den vollständigen Vertrag beschreibt [`openapi/openapi.yaml`](../openapi/openapi.yaml).

## Haushalte, Konten, Import (E1)

- Jede Person bekommt beim Anlegen ihren **privaten Haushalt** (Datenbank-Trigger). Den
  **gemeinsamen Haushalt** legt `cli gemeinsam-anlegen <Person-ID> <Person-ID> [Name]` an.
- Eine Person sieht nur Konten, Buchungen und Serien aus Haushalten, deren Mitglied sie ist.
  Fremde Konten liefern 404, auch beim Import.
- `POST /v1/accounts/{accountId}/imports` übernimmt gebuchte Umsätze idempotent: Schlüssel ist
  die Quell-ID, sonst ein Hash aus Konto, Buchungstag, Betrag, Verwendungszweck und Gegenpartei plus Vorkommen
  (gleiche Buchungen am selben Tag). Abrufe sollten ganze Tage abdecken. Details:
  [ADR 0002](../docs/adr/0002-bankanbindung.md).
- Nach jedem Import werden die **wiederkehrenden Buchungen** des Kontos neu erkannt
  (`GET /v1/recurring`): Rhythmus wöchentlich bis jährlich, typischer Betrag (Median), nächste
  erwartete Buchung, `beendet`, wenn sie deutlich überfällig ist.
