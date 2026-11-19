# E6 Web: Auswertungen im Browser – Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Auswertungen aus E5 als Web-Oberfläche unter `/`, angemeldet per Passkey mit HttpOnly-Cookie, ausgeliefert vom Backend.

**Architecture:** Das Backend bekommt eine Cookie-Sitzung (nur lesend plus Logout) und liefert einen Vite-Build aus `web/dist` mit der bestehenden strengen CSP aus. Das neue Paket `web/` (Preact, TypeScript) nutzt einen aus `openapi/openapi.yaml` erzeugten Client und portiert die reine Aufbereitung (`AnalyticsPresentation.swift`, `Sankey.swift`, `Money.swift`) mit Tests. Gezeichnet wird mit eigenem SVG.

**Tech Stack:** Node 22, Hono/zod-openapi (Backend), Vite, Preact, TypeScript strict, openapi-typescript + openapi-fetch, Vitest, Biome, pnpm 10.

**Spec:** `docs/superpowers/specs/2026-11-19-web-auswertungen-design.md` (ADR 0001, ADR 0005 als Grundlage)

## Global Constraints

- Öffentliches Repo: nur erfundene Testdaten (Namen wie „Person A“, Beträge frei erfunden), keine Secrets.
- Beträge ganze Cent, Anteile Basispunkte; Umrechnung nur zur Anzeige.
- Cookie exakt: `__Host-freiraum_session=<frs_…>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=<sessionTtlDays·86400>`.
- Cookie gilt nur für `GET`/`HEAD`, und für `POST /v1/auth/logout` nur mit `Origin` ∈ `config.webauthn.origins`. Bearer hat Vorrang.
- `PAGE_CSP` aus `backend/src/routes/web.ts` bleibt unverändert (inkl. `require-trusted-types-for 'script'`); keine Inline-Skripte/-Stile, keine fremden Hosts, kein `innerHTML`/`dangerouslySetInnerHTML`, kein `localStorage`/`sessionStorage`/`document.cookie` im Web-Code.
- Texte und Zahlenformate wie in der Mac-App: Money „1.390 €“ / „34,18 €“ mit U+2212-Minus und U+00A0 vor „€“; Anteile wie `RatioText`.
- Backend-Gates: `pnpm lint`, `pnpm typecheck`, `pnpm test` in `backend/`; API-Änderung → `pnpm openapi`, `openapi/openapi.yaml` mitcommitten.
- Web-Gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` in `web/`.
- Commits: Deutsch, Kennung `FREI-7` im Body, Attribution-Zeilen der Sitzung.

## Review Focus

1. Cookie an einer schreibenden Route (z. B. `POST /v1/households/{id}/budget/{m}/moves`) → 401, auch mit passendem `Origin` (Task 1).
2. Cookie und Bearer verschiedener Personen gleichzeitig → es gilt die Person des Bearer-Tokens (Task 1).
3. Abgelaufene/gelöschte Sitzung im Cookie → 401 bei `/v1/me`, Web-Seite zeigt die Anmeldeansicht statt eines Fehlers (Task 1, Task 6).
4. Pfad-Tricks bei `/assets/` (`/assets/../package.json`, `/assets/%2e%2e/…`, unbekannte Datei) → 404 JSON, nie Dateisystem außerhalb der beim Start gelisteten Dateien (Task 2).
5. Haushalt ohne Budgetbeginn-Historie, Zeitraum „Jahr“ im ersten Budgetmonat, Haushalt-ID aus alter Adresse nicht mehr vorhanden → Zeitraum beginnt beim Budgetbeginn, unbekannter Haushalt fällt auf den ersten zurück (Task 4, Task 6).

---

### Task 1: Cookie-Sitzung im Backend

**Files:**
- Modify: `backend/src/auth/middleware.ts`, `backend/src/routes/auth.ts`, `backend/src/routes/common.ts`, `backend/src/app.ts` (Security-Scheme `cookieAuth`, `AppEnv.session` erweitern), alle GET-Routen in `backend/src/routes/*.ts` (Security-Angabe)
- Create: `backend/src/auth/cookie.ts`
- Test: `backend/test/web-session.test.ts`
- Regenerate: `openapi/openapi.yaml`

**Interfaces:**
- Produces: `SESSION_COOKIE = '__Host-freiraum_session'`; `sessionCookie(token: string, maxAgeSeconds: number): string`; `clearSessionCookie(): string` (in `auth/cookie.ts`)
- Produces: `requireAuth` (Bearer, oder Cookie bei GET/HEAD) und `requireAuthOrWebLogout` (Bearer, oder Cookie mit erlaubtem `Origin`) in `auth/middleware.ts`; `c.var.session` = `{ id, person, via: 'bearer' | 'cookie', token: string }`
- Produces: `POST /v1/auth/login/verify-web` → 200 `{ expiresAt, person }` (Schema `WebSession`), Set-Cookie; gleiche Fehlercodes wie `login/verify`
- Produces: `authRead = [{ bearerAuth: [] }, { cookieAuth: [] }]` und `authWrite = [{ bearerAuth: [] }]` in `routes/common.ts`

- [ ] **Step 1: Write failing tests** in `web-session.test.ts` (Passkey-Ablauf mit `SoftAuthenticator` wie in `auth.test.ts`, Cookie per `cookie`-Header mitsenden):
  - `login/verify-web setzt den Cookie und liefert kein Token`: Status 200, Body hat `person.displayName === 'Person A'` und kein Feld `token`; `set-cookie` beginnt mit `__Host-freiraum_session=frs_` und enthält `Path=/`, `Secure`, `HttpOnly`, `SameSite=Strict`, `Max-Age=7776000`.
  - `Cookie öffnet lesende Endpunkte`: `GET /v1/me` mit Cookie → 200; `GET /v1/households` → 200.
  - `Cookie öffnet keine schreibenden Endpunkte`: `POST /v1/accounts` mit Cookie und `origin: ORIGIN` → 401 `nicht_angemeldet`.
  - `Logout per Cookie nur mit passendem Origin`: ohne `origin` → 401; `origin: 'https://evil.test'` → 401; `origin: ORIGIN` → 204, `set-cookie` enthält `Max-Age=0`; danach `GET /v1/me` mit altem Cookie → 401.
  - `Bearer hat Vorrang vor Cookie`: Cookie von Person A, Bearer von Person B → `/v1/me` liefert B.
  - `GET /v1/me erneuert den Cookie nur bei Cookie-Anmeldung`: mit Cookie → `set-cookie` vorhanden; mit Bearer → kein `set-cookie`.
  - `Private Auswertung der anderen Person bleibt 404 auch per Cookie`: Person B per Cookie auf `GET /v1/households/{privat A}/analytics/metrics` → 404.
- [ ] **Step 2: Run** `cd backend && pnpm vitest run test/web-session.test.ts` → FAIL (Route fehlt).
- [ ] **Step 3: Implement** Cookie-Helfer, beide Middlewares (Cookie aus `cookie`-Header parsen; `authenticate(token)` wiederverwenden), `login/verify-web` (nutzt `finishLogin`, setzt Cookie mit `config.sessionTtlDays`), Logout-Route auf `requireAuthOrWebLogout` umstellen und bei `via === 'cookie'` Cookie löschen, `/v1/me` erneuert bei `via === 'cookie'`. `cookieAuth` (`type: apiKey, in: cookie, name: __Host-freiraum_session`) registrieren; alle `method: 'get'`-Routen auf `security: authRead`, übrige auf `authWrite`. Die Config braucht dafür `webauthn.origins` (vorhanden) – `AuthService` oder Middleware kommt über `c.var.auth` an die Config; falls nicht, Origins per `c.set('config', …)` bereitstellen.
- [ ] **Step 4: Run** `pnpm openapi && pnpm lint && pnpm typecheck && pnpm test` → alles grün (inkl. `app.test.ts`-Abgleich mit `openapi.yaml`).
- [ ] **Step 5: Commit** „Backend: Sitzung per HttpOnly-Cookie für die Web-Oberfläche“.

### Task 2: Auslieferung des Web-Builds

**Files:**
- Modify: `backend/src/config.ts` (`webDistDir: string | null`, Env `WEB_DIST_DIR`, Standard `fileURLToPath(new URL('../web/', import.meta.url))`, nur wenn `index.html` dort existiert, sonst `null`), `backend/src/routes/web.ts`, `backend/test/helpers/app.ts` (`webDistDir: null`), `backend/public/registrieren.html`/`.js` (nach erfolgreichem Anlegen Link „Zur Auswertung“ auf `/`)
- Test: `backend/test/web.test.ts` (erweitern)

**Interfaces:**
- Consumes: `PAGE_CSP`, `SECURITY_HEADERS` (bestehend)
- Produces: `webRoutes(app, config)`; bei `webDistDir`: `GET /` → `index.html` (`no-store`), `GET /assets/<datei>` → nur Dateien, die beim Start in `<dir>/assets/` gelistet wurden, `cache-control: public, max-age=31536000, immutable`, Typ nach Endung (`.js`, `.css`, `.svg`, `.woff2`, `.png`); sonst `GET /` → 302 `/registrieren` wie bisher

- [ ] **Step 1: Write failing tests** (neues `describe('Web-Oberfläche')` mit eigenem `createApp` und `webDistDir` = temporäres Verzeichnis mit `index.html` und `assets/app-abc123.js`, `assets/app-abc123.css`):
  - `/ liefert index.html mit strengen Headern` (Status 200, `no-store`, `expectStrictHeaders`).
  - `/assets liefert gelistete Dateien unveränderlich` (Typ `text/javascript; charset=utf-8`, `immutable`, strenge Header).
  - `/assets lehnt Unbekanntes und Pfad-Tricks ab`: `/assets/fehlt.js`, `/assets/../index.html`, `/assets/%2e%2e%2findex.html` → 404 mit `nicht_gefunden`.
  - Bestehender Test „führt von der Startseite zur Registrierung“ bleibt mit `webDistDir: null` grün.
- [ ] **Step 2: Run** `pnpm vitest run test/web.test.ts` → FAIL.
- [ ] **Step 3: Implement** in `web.ts`: Dateiliste per `readdirSync` beim Start, Map `name → { content: Buffer, type }`; Route `/assets/:name` schlägt nur in der Map nach.
- [ ] **Step 4: Run** Backend-Gates → grün.
- [ ] **Step 5: Commit** „Backend: Web-Oberfläche unter / ausliefern“.

### Task 3: Paket `web/` mit Client und Formaten

**Files:**
- Create: `web/package.json`, `web/pnpm-lock.yaml`, `web/tsconfig.json`, `web/vite.config.ts`, `web/biome.json`, `web/index.html`, `web/src/main.tsx` (Platzhalter „Freiraum“), `web/src/api/schema.d.ts` (generiert), `web/src/api/client.ts`, `web/src/lib/money.ts`, `web/src/lib/month.ts`
- Test: `web/src/api/schema.test.ts`, `web/src/lib/money.test.ts`, `web/src/lib/month.test.ts`
- Modify: `.gitignore` (`web/node_modules`, `web/dist`)

**Interfaces:**
- Produces: Skripte `dev` (Vite, Proxy `/v1` → `http://localhost:3000`), `build`, `gen` (`openapi-typescript ../openapi/openapi.yaml -o src/api/schema.d.ts`), `lint`, `format`, `typecheck` (`tsc --noEmit`), `test`
- Produces: `api` = `createClient<paths>({ baseUrl: '', credentials: 'same-origin' })`; Typ-Aliase `Metrics`, `Flow`, `PersonFlow`, `Anomalies`, `Goals`, `OwnershipCosts`, `Household`, `Person` aus `components['schemas']`; `class ApiError { status: number; code: string; message: string }` und `unwrap<T>(r): T` (wirft `ApiError` mit Server-Meldung)
- Produces: `money(cents: number, opts?: { exact?: boolean; sign?: boolean }): string` (Port von `Money.format`), `MINUS = '−'`, `ratio(bp: number | null): string`, `points(deltaBp: number): string` (Port von `RatioText`)
- Produces: `type YearMonth = string` (`'2026-11'`), `previous(m)`, `next(m)`, `compare(a,b)`, `monthTitle(m)` („November 2026“), `monthShort(m)` („Nov“, Liste wie `GermanDates.monthShort`), `monthName(m)`, `currentMonth(today: Date)`

- [ ] **Step 1:** Vite-Konfig: `build.modulePreload.polyfill: false`, `build.assetsDir: 'assets'`, kein Inline-Asset (`build.assetsInlineLimit: 0`); `index.html` ohne Inline-Skript/-Stil, `<meta name="robots" content="noindex, nofollow">`, `color-scheme: light dark`.
- [ ] **Step 2: Write failing tests**:
  - `money`: `money(21500) === '215 €'`, `money(3418) === '34,18 €'`, `money(-3418) === '−34,18 €'`, `money(139000) === '1.390 €'`, `money(21500, { exact: true }) === '215,00 €'`, `money(500, { sign: true }) === '+5 €'`, `money(0) === '0 €'`.
  - `ratio`/`points`: Fälle aus `AnalyticsTests.swift` `anteileAlsText` 1:1 übernehmen (u. a. `ratio(2834) === '28 %'`, `ratio(50) === '0,5 %'`, `ratio(null) === '–'`, `points(0) === 'gleich'`, `points(100) === '+1 Punkt'`, `points(-300) === '−3 Punkte'`).
  - `month`: `previous('2026-01') === '2025-12'`, `monthTitle('2026-11') === 'November 2026'`, `monthShort('2026-09') === 'Sept'`.
  - `schema.test.ts`: `openapiTS` + `astToString` auf `../openapi/openapi.yaml` erzeugt exakt den Inhalt von `src/api/schema.d.ts` (Meldung: „pnpm gen ausführen“).
- [ ] **Step 3: Run** `cd web && pnpm test` → FAIL.
- [ ] **Step 4: Implement**, `pnpm gen` ausführen.
- [ ] **Step 5: Run** alle Web-Gates → grün; `grep -L '<script>' dist/index.html` bestätigt kein Inline-Skript.
- [ ] **Step 6: Commit** „Web: Paket mit erzeugtem API-Client und Formaten“.

### Task 4: Aufbereitung der Auswertungen

**Files:**
- Create: `web/src/lib/presentation.ts`
- Test: `web/src/lib/presentation.test.ts`

**Interfaces:**
- Consumes: Task 3 (`money`, `ratio`, `points`, Monatsfunktionen, Schema-Typen)
- Produces: `type Period = 'monat' | 'quartal' | 'jahr'`, `PERIOD_TITLES`, `periodRange(period, to, budgetStart: YearMonth | null): { from: YearMonth; to: YearMonth }`, `historyRange(to, budgetStart)`, `periodTitle(range)`
- Produces: `buildAnalytics({ summary, history, flow, anomalies, goals, ownership }): AnalyticsView` mit Feldern wie `AnalyticsState` (ohne `flowList`): `periodTitle`, `tiles: MetricTile[]` (`{ id, title, value, unit, detail, tone: 'neutral'|'good'|'warning' }`), `savingsRate`, `fixedCostShare`, `ageOfMoney: TrendPoint[]` (`{ month, label, value: number|null, text, isCurrent }`), `anomalies: AnomalyRow[]` (`{ id, title, badge }`), `goals: GoalRow[]`, `assets: AssetRow[]`, `assetSummary`, `flowSummary`, `uncategorizedNote`

- [ ] **Step 1: Write failing tests** als Port von `AnalyticsTests.swift`: `zeitraumBeginntFruehestensMitDemBudget`, `kachelnMitVergleich`, `ohneHistorieUndOhneEinkommen`, `runwayMitFesterEinzahlung`, `zieleUndBesitz` – gleiche Eingaben (als JSON in API-Form), gleiche erwarteten Texte. Dazu: `periodRange('jahr', '2026-11', '2026-11')` → `{ from: '2026-11', to: '2026-11' }`.
- [ ] **Step 2: Run** `pnpm vitest run src/lib/presentation.test.ts` → FAIL.
- [ ] **Step 3: Implement** als direkte Portierung von `AnalyticsPresentation.swift` (Texte wörtlich übernehmen).
- [ ] **Step 4: Run** → PASS, Web-Gates grün.
- [ ] **Step 5: Commit** „Web: Aufbereitung der Auswertungen wie in der Mac-App“.

### Task 5: Sankey-Layout

**Files:**
- Create: `web/src/lib/sankey.ts`
- Test: `web/src/lib/sankey.test.ts`

**Interfaces:**
- Produces: `layoutSankey(flow: { nodes: FlowNodeLike[]; links: FlowLink[] }, width: number, height: number, opts?: { nodeWidth?: number /*14*/; nodePadding?: number /*12*/ }): SankeyLayout` mit `nodes` (`id, label, kind, potKind, householdId|null, column, valueCents, x0, x1, y0, y1`), `links` (`source, target, valueCents, x0, x1, sourceY0, sourceY1, targetY0, targetY1`), `columns`, `scale`; `linkAt(layout, x, y)`, `labelLeading(layout, node)`, `linkPath(link): string` (SVG-Pfad, kubische Kurve mit Kontrollpunkten auf halber Strecke)

- [ ] **Step 1: Write failing tests** als Port aller sieben Tests aus `SankeyTests.swift` (gleiche Knoten/Kanten, gleiche Erwartungen).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** als Portierung von `SankeyLayout.init` (Algorithmus dort: längster Weg mit Rundenbegrenzung, Senken in letzte Spalte, gemeinsamer Maßstab, Bänder nach y0 der Gegenseite und API-Reihenfolge).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** „Web: Sankey-Layout als reine Funktion“.

### Task 6: Oberfläche

**Files:**
- Create: `web/src/main.tsx`, `web/src/app.tsx` (Zustand, Laden), `web/src/state.ts` (Query ⇄ Zustand), `web/src/login.tsx` (Passkey-Anmeldung, base64url-Helfer aus `registrieren.js` als TS), `web/src/views/{header,tiles,flow,trends,anomalies,goals,assets}.tsx`, `web/src/styles.css`
- Test: `web/src/state.test.ts`

**Interfaces:**
- Consumes: Tasks 3–5
- Produces: `readState(search: string): { haushalt?: string; monat?: YearMonth; zeitraum: Period; fluss: 'haushalt' | 'person' }`, `writeState(state): string` (Query ohne Standardwerte); ungültige Werte fallen auf Standard zurück

- [ ] **Step 1: Write failing tests** für `state.ts`: Roundtrip, `?zeitraum=foo` → `'monat'`, `?monat=2026-13` → `undefined`.
- [ ] **Step 2: Implement** `state.ts` → Tests grün.
- [ ] **Step 3: Implement** Oberfläche nach Spec Abschnitt 5: Start mit `GET /v1/me` (401 → Login-Ansicht), Haushalte laden, unbekannte `haushalt`-ID → erster Haushalt; Budgetbeginn aus `GET /v1/households/{id}/budget/{monat}`; parallel `metrics` (Zeitraum), `metrics` (Verlauf), `flow` bzw. `persons/{me}/analytics/flow`, `anomalies`, `goals`, `ownership-costs`; jedes 401 → Login-Ansicht. Umschalter „Über meine Haushalte“ nur mit gemeinsamem Haushalt. Sankey als SVG mit `viewBox`, Hover-Hinweis über `linkAt`; Verläufe als einfache SVG-Balken. Farben über CSS-Variablen hell/dunkel, Ton `good`/`warning` nur dort, wo die Mac-App sie setzt. Logout ruft `POST /v1/auth/logout` und zeigt die Anmeldeansicht.
- [ ] **Step 4: Run** Web-Gates; `grep -rE 'innerHTML|dangerouslySetInnerHTML|localStorage|sessionStorage|document\.cookie' web/src` → keine Treffer.
- [ ] **Step 5: Browser-Prüfung** (Chromium/Playwright, Skript im Scratchpad): Backend lokal mit Test-Postgres, `WEB_DIST_DIR=web/dist`, `WEBAUTHN_RP_ID=localhost`, `WEBAUTHN_ORIGINS=http://localhost:3000`; Person per CLI anlegen, Passkey per virtuellem Authenticator (CDP `WebAuthn.addVirtualAuthenticator`) über `/registrieren` anlegen, dann `/` → anmelden, neu laden (weiter angemeldet), Monat/Zeitraum wechseln, Abmelden. Keine Konsolenmeldungen zu CSP/Trusted Types, keine Anfrage an fremde Hosts. Screenshot ansehen.
- [ ] **Step 6: Commit** „Web: Auswertungen im Browser“.

### Task 7: Image, CI, Betrieb, Doku

**Files:**
- Modify: `backend/Dockerfile` (Kontext = Repo-Wurzel: `COPY backend/…`; neue Stufe `web-build` auf `base`, `WORKDIR /web`, `pnpm install --frozen-lockfile && pnpm build`; Runtime `COPY --from=web-build /web/dist ./web`), `.github/workflows/backend.yml` (Image-Job `context: .`, `file: backend/Dockerfile`, Pfade + `web/**`), `.github/workflows/image-check.yml` (dito), `deploy/README.md`
- Create: `.dockerignore` (Wurzel: `**/node_modules`, `**/dist`, `apple`, `docs`, `.git`), `.github/workflows/web.yml` (Pfade `web/**`, `openapi/**`; lint, typecheck, test, build), `docs/adr/0007-web-oberflaeche.md`
- Modify: `docs/adr/0001-technik-grundgeruest.md` (Verweis auf ADR 0007 beim Cookie-Satz), Spec-Plattformtabelle (Web: E6, ADR 0007)

- [ ] **Step 1:** Dateien anpassen; `docker build -f backend/Dockerfile .` lokal, falls Docker verfügbar (sonst prüft `image-check.yml` im PR).
- [ ] **Step 2:** Backend- und Web-Gates erneut → grün.
- [ ] **Step 3: Commit** „Image und CI für die Web-Oberfläche, ADR 0007“.
