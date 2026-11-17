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
| `LLM_API_KEY` | nein | | Schlüssel für OpenRouter; ohne ihn bleibt das LLM aus (nur Regeln schlagen vor) |
| `LLM_MODEL` | mit Schlüssel | | Modell, z. B. `anbieter/modell`; es muss strukturierte Ausgabe (JSON-Schema) können |
| `LLM_BASE_URL` | nein | `https://openrouter.ai/api/v1` | andere OpenAI-kompatible Schnittstelle, etwa ein lokales Modell |
| `LLM_TIMEOUT_MS` | nein | `60000` | Zeitlimit je Anfrage (eine Anfrage trägt bis zu 20 Buchungen) |
| `LLM_ZDR` | nein | `true` | bei OpenRouter nur Anbieter ohne Datenspeicherung (Zero Data Retention) |

## Anmeldung (Ablauf)

1. `POST /v1/auth/registration/options` mit Einladungs-Token → `challengeId` + WebAuthn-Optionen
2. Gerät erzeugt den Passkey → `POST /v1/auth/registration/verify` → Sitzung (`token`)
3. Später: `POST /v1/auth/login/options` → `POST /v1/auth/login/verify` → Sitzung
4. Alle weiteren Aufrufe mit `Authorization: Bearer <token>`

Ohne App geht Schritt 1–2 im Browser unter `/registrieren` (statische Seite aus `public/`, ohne
Build-Schritt, strenge CSP, nicht Teil des OpenAPI-Vertrags). Die Seite hat auch „Anmelden
testen“ (Schritt 3 plus `GET /v1/me`). Ablauf im Betrieb: [`deploy/README.md`](../deploy/README.md).

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

## Budget und Kategorisierung (E2)

Rechenregeln und Begründungen: [ADR 0003](../docs/adr/0003-budget-kern.md).

- **Töpfe** je Haushalt (`/v1/households/{id}/pots`): `monatlich`, `ruecklage` (Jahresbetrag),
  `ziel` (Zielbetrag, optional Zielmonat), `erst_ich` (fester Monatsbetrag oder Anteil der
  Einnahmen). Archivieren nur, wenn der Topf leer ist.
- **Budget eines Monats** (`GET /v1/households/{id}/budget/{JJJJ-MM}`): „Noch ohne Aufgabe“,
  Einnahmen, Überziehung aus dem Vormonat und je Topf Übertrag, Zuweisung, Aufteilungen,
  Verfügbar, Plan und noch Fehlendes.
- **Zuweisen** (`PUT …/budget/{Monat}/pots/{potId}`): Erhöhen nur, solange „Noch ohne Aufgabe“
  nicht negativ wird; Senken immer.
- **Erst ich** füllt sich nach jeder neuen Einnahme von selbst (in Reihenfolge der Töpfe, soweit
  Geld da ist). Eine eigene Zuweisung schaltet die Automatik für Topf und Monat ab.
- **Monatsabschluss** (`POST …/budget/{Monat}/closing`): nur vergangene Monate, der Reihe nach,
  alle Buchungen bestätigt. Danach keine Zuweisungen mehr in diesem Monat.
- **Kategorisierung:** Regeln greifen beim Import, ohne Treffer fragt ein LLM (falls angebunden).
  Vorschläge zählen sofort im Budget (`vorgeschlagen`). `GET /v1/transactions/pending` listet,
  was auf Bestätigung wartet; `POST /v1/transactions/{id}/confirm` bestätigt mit einem Tipp,
  `PUT /v1/transactions/{id}/splits` korrigiert oder teilt auf. Eine Korrektur wird zur Regel
  (`/v1/households/{id}/rules`) und schlägt offene Buchungen neu vor.
- **LLM-Vorschläge** über OpenRouter, sobald `LLM_API_KEY` und `LLM_MODEL` gesetzt sind. Das
  Modell sieht Datum, Betrag, Gegenpartei-Name, Verwendungszweck (IBANs maskiert) und die Töpfe
  des Haushalts, sonst nichts. Die Vorschläge kommen im Hintergrund: Der Import antwortet sofort,
  das Modell bekommt bis zu 20 Buchungen je Anfrage (höchstens 3 Anfragen gleichzeitig). Ist es
  nicht erreichbar, holt der Server die Vorschläge beim Start und alle 15 Minuten nach. Details
  und Abwägung: ADR 0003.
