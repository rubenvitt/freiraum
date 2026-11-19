# E6 Web: Auswertungen im Browser – Design

Stand: 19.11.2026 · Status: Entwurf · Aufgabe: FREI-7 · Grundlage: [Freiraum-Spec](2026-11-17-freiraum-design.md), [ADR 0001](../../adr/0001-technik-grundgeruest.md), [ADR 0005](../../adr/0005-auswertungen.md)

## Absicht

Die Auswertungen von Freiraum sollen im Browser verfügbar sein, ohne etwas zu installieren.
Genutzt wird die Seite auf dem **persönlichen MacBook** (Entscheidung Ruben, 19.11.2026), also
auf einem eigenen Gerät: Die Anmeldung darf über Neuladen und Tage hinweg bestehen bleiben. Die
Web-Oberfläche zeigt dieselben Auswertungen wie die macOS-App (`apple/Freiraum/Views/Mac/AnalyticsView.swift`)
und rechnet selbst nichts: Alle Zahlen kommen aus den E5-Endpunkten.

## Ziele

- Anmelden mit Passkey im Browser, Sitzung bleibt bestehen (Cookie), Abmelden möglich.
- Eine Seite „Auswertungen“ mit Haushaltswahl, Monat (vor/zurück) und Zeitraum (Monat, Quartal, Jahr):
  - Kennzahlen-Kacheln: Sparquote, Fixkostenanteil, Runway, Alter des Geldes
  - Geldfluss als Sankey, umschaltbar auf „Über meine Haushalte“ (`/v1/persons/{id}/analytics/flow`)
  - Verlauf (bis 12 Monate, ab Budgetbeginn): Sparquote und Fixkostenanteil je Monat
  - Auffälligkeiten des Monats
  - Ziele mit Prognose
  - Besitzkosten
- Client-Typen werden aus `openapi/openapi.yaml` erzeugt. Läuft die API auseinander, schlägt die
  Typprüfung fehl, nicht der Browser.
- Hell und dunkel nach Systemeinstellung, gut lesbar auf einem MacBook-Bildschirm.

## Nicht-Ziele

- Nichts Schreibendes: kein Bestätigen, kein Budget, keine Besitz-Pflege, keine Freigaben ändern.
  Die Web-Oberfläche bleibt „zunächst nur Auswertungen“ (Spec, Plattformen).
- Keine Optimierung für das iPhone (dafür gibt es die App). Schmale Fenster dürfen einspaltig
  werden, mehr nicht.
- Kein Offline-Betrieb, kein Service Worker, keine PWA.
- Kein Passkey-Anlegen in der neuen Oberfläche; dafür bleibt `/registrieren`.

## Anti-Ziele (wäre ein Fehlschlag, auch wenn es läuft)

- Das Sitzungs-Token ist für Skripte der Seite lesbar (Body, `localStorage`, `document.cookie`).
- Die Seite lädt etwas von fremden Servern (Schriften, CDN, Telemetrie) oder braucht eine
  aufgeweichte CSP (`unsafe-inline`, `unsafe-eval`, fremde Hosts).
- Die Seite rechnet Kennzahlen aus Buchungen nach oder filtert Privates selbst weg. Die Grenze
  bleibt am Server. (Vergleiche zwischen Werten, die der Server geliefert hat, sind Darstellung,
  siehe Entscheidung 6.)
- Ein Cookie öffnet schreibende Endpunkte (CSRF-Fläche).

## Rahmen

- Öffentliches Repo: Testdaten erfunden, keine echten Namen, Konten oder Beträge.
- Beträge sind ganze Cent, Anteile Basispunkte. Umgerechnet wird nur zur Anzeige.
- Ein Container: Das Backend liefert die Web-Oberfläche aus, gleicher Ursprung wie die API
  (kein CORS, Passkeys gelten für dieselbe `WEBAUTHN_RP_ID`).
- Backend-Gates bleiben: `pnpm lint`, `pnpm typecheck`, `pnpm test`. API-Änderung → `pnpm openapi`
  und `openapi/openapi.yaml` mitcommitten.

## Wege (betrachtet)

| Weg | Kurz | Abwägung |
|---|---|---|
| A | Plain-JS ohne Build in `backend/public/`, wie `/registrieren` | nichts Neues im Stack; aber der „generierte Client“ wäre nur ein Kommentar, und sechs Ansichten mit Zustand werden als DOM-Code zäh |
| **B** | **Eigenes Paket `web/`: Vite, TypeScript, Preact, Client aus OpenAPI; das Backend liefert den Build aus** | Typprüfung gegen den API-Vertrag, Logik testbar; dafür ein zweites pnpm-Paket und eine Build-Stufe im Image |
| C | Eigenständiges Frontend (z. B. SvelteKit) als zweiter Container | eigenes Deployment, CORS, zweite Domain für Passkeys, weichere CSP – verworfen |

**Gewählt: B** (Ruben, 19.11.2026).

## Entscheidungen

### 1. Sitzung im Browser: HttpOnly-Cookie (Ruben: Anmeldung darf bleiben; Ausgestaltung: meine Wahl)

- Neuer Endpunkt `POST /v1/auth/login/verify-web` mit demselben Body wie `login/verify`. Er erzeugt eine
  Sitzung im bestehenden Modell (`sessions`, Hash, gleitender Ablauf `SESSION_TTL_DAYS`), setzt
  aber das Token **nur** als Cookie und gibt im Body nur `{ expiresAt, person }` zurück.
- Cookie: `__Host-freiraum_session=<frs_…>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=<TTL>`.
  Der Präfix `__Host-` erzwingt `Secure`, `Path=/` und keine `Domain`.
- `requireAuth` nimmt weiterhin `Authorization: Bearer`. Den Cookie nimmt es nur an, wenn
  - die Methode `GET` oder `HEAD` ist, **oder**
  - die Route ausdrücklich `allowCookieWrite` hat (nur `POST /v1/auth/logout`) **und** der
    `Origin`-Header einer der `WEBAUTHN_ORIGINS` ist.

  Sonst gilt der Cookie als nicht vorhanden (401). Damit kann ein Cookie keine Daten ändern; es
  braucht keine CSRF-Tokens.
- Gibt es beides, gilt der Bearer-Header (die Apps ändern sich nicht).
- `POST /v1/auth/logout` löscht die Sitzung und setzt den Cookie mit `Max-Age=0`.
- Läuft die Sitzung serverseitig gleitend weiter, wird auch der Cookie erneuert: `GET /v1/me` setzt
  ihn bei Anmeldung per Cookie neu (die Seite ruft `/v1/me` bei jedem Laden). Andere Antworten
  setzen keinen Cookie.
- OpenAPI: neuer `securitySchemes`-Eintrag `cookieAuth` (`apiKey`, `in: cookie`), bei den lesenden
  Routen zusätzlich zu `bearerAuth` angegeben, damit der Vertrag stimmt. Ob das per Helfer
  zentral passiert oder je Route, entscheidet der Builder.
- Lokale Entwicklung: Browser akzeptieren `Secure`-Cookies auf `http://localhost`. Der
  Vite-Dev-Server leitet `/v1` an das Backend weiter (gleicher Ursprung aus Sicht des Browsers);
  `WEBAUTHN_ORIGINS` braucht dann `http://localhost:5173`.

### 2. Paket `web/` (meine Wahl im Rahmen von B)

- Ort: `web/` im Repo-Wurzelverzeichnis, eigenes `package.json` und `pnpm-lock.yaml` (wie
  `backend/`, kein Workspace).
- Vite + TypeScript (strict) + Preact. Keine UI- oder Chart-Bibliothek, keine Schriften von außen
  (Systemschrift, `font-variant-numeric: tabular-nums` für Zahlen).
- Client: `openapi-typescript` erzeugt `web/src/api/schema.d.ts` aus `../openapi/openapi.yaml`
  (Skript `pnpm gen`, Datei versioniert), Aufrufe über `openapi-fetch` mit `credentials: 'same-origin'`.
  Ein Test (oder CI-Schritt) prüft, dass `schema.d.ts` zur aktuellen `openapi.yaml` passt.
- Lint und Format mit Biome (wie das Backend), Tests mit Vitest.
- Gates in `web/`: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

### 3. Auslieferung durch das Backend

- Vite baut nach `web/dist/` (`index.html` plus gehashte Dateien unter `/assets/`).
- Das Backend liest beim Start ein Verzeichnis (`WEB_DIST_DIR`, Standard `./web` neben `dist/`
  im Image) und liefert aus:
  - `/` → `index.html`, `cache-control: no-store`
  - `/assets/*` → Datei aus dem Build, `cache-control: public, max-age=31536000, immutable`,
    Content-Type nach Endung, nur Dateien, die beim Start gelistet wurden (kein Pfad aus der
    Anfrage auf das Dateisystem).
  - alle mit denselben Sicherheits-Headern wie `/registrieren` (`PAGE_CSP` usw.).
- Fehlt das Verzeichnis (Backend-Tests, lokale Entwicklung ohne Build), bleibt `/` die
  Weiterleitung auf `/registrieren`. Die Backend-Tests hängen nicht vom Web-Build ab; sie testen
  die Auslieferung mit einem kleinen Test-Verzeichnis.
- `/registrieren` bleibt unverändert und verlinkt nach dem Anlegen eines Passkeys auf `/`.
- Die Seite kennt nur eine Adresse (`/`). Haushalt, Monat, Zeitraum und Sankey-Umschalter stehen
  in der Query (`?haushalt=…&monat=2026-11&zeitraum=quartal&fluss=person`), damit Neuladen und
  Lesezeichen funktionieren. Kein Client-Router.

### 4. CSP und Trusted Types

- Die bestehende `PAGE_CSP` gilt unverändert, auch `require-trusted-types-for 'script'`.
- Vite-Build ohne Inline-Skripte und ohne Inline-Stile im HTML (`build.modulePreload.polyfill: false`,
  CSS als Datei). Preact setzt kein `innerHTML` (ohne `dangerouslySetInnerHTML`, das im Code
  verboten ist).
- SVG-Attribute wie `style` setzt Preact über das DOM (CSSOM), nicht als HTML; das erlaubt
  `style-src 'self'`. Der Builder prüft im echten Browser mit Konsole, dass keine CSP- oder
  Trusted-Types-Verletzung auftritt.

### 5. Inhalte der Seite

Vorbild ist die macOS-App (`AnalyticsView.swift`, `AnalyticsComponents.swift`,
`AnalyticsPresentation.swift`). Der Entwurf „Mac/Web Auswertung“
(https://claude.ai/artifact/Uioh2erQiqv4nLqFDVfp6P) ist aus dieser Sitzung nicht lesbar; die
Mac-App setzt ihn bereits um und gilt deshalb als Vorlage (meine Wahl). Texte, Hinweise unter den
Kacheln, Farben mit Bedeutung und Zahlenformate folgen der Mac-App. Aufbau von oben nach unten:

1. Kopfleiste: Marke, Haushaltswahl (aus `GET /v1/households`), Monat mit vor/zurück,
   Zeitraum Monat/Quartal/Jahr, Abmelden.
2. Kacheln: Sparquote (Zeitraum), Fixkostenanteil, Runway (Monate, mit „auf Basis von n Monaten“),
   Alter des Geldes (Tage, letzter Monat des Zeitraums). `null` wird „–“ mit kurzem Grund
   („kein Einkommen“, „noch keine Historie“).
3. Geldfluss (Sankey) über den Zeitraum, Umschalter „Dieser Haushalt / Über meine Haushalte“
   (nur sichtbar, wenn die Person einen gemeinsamen Haushalt hat).
4. Verlauf wie in der Mac-App: Sparquote, Fixkostenanteil und Alter des Geldes über bis zu 12
   Monate bis zum gewählten Monat.
5. Auffälligkeiten des Monats als Liste (Titel aus der API).
6. Ziele: Fortschrittsbalken, Prognose, Status, „monatlich nötig“.
7. Besitzkosten: je Besitz Kosten im Zeitraum, Monatsschnitt, Einstufung, Anteil am Konsum.

Zeitraum-Regel wie in `AnalyticsPresentation.swift`: endet im gewählten Monat, beginnt frühestens
beim Budgetbeginn (`budgetStartMonth` aus `GET /v1/households/{id}/budget/{Monat}`), höchstens die
erlaubte Spanne der API.

Anmeldeansicht (ohne Sitzung, `GET /v1/me` → 401): ein Knopf „Mit Passkey anmelden“, Ablauf wie
in `registrieren.js` (`login/options` → `navigator.credentials.get` → `login/verify-web`). Hinweis
und Link auf `/registrieren`, falls noch kein Passkey existiert. Wird eine Antwort später 401,
wechselt die Seite zur Anmeldeansicht.

Fehler: API-Meldungen (`error.message`) werden angezeigt, nicht verschluckt. 404 eines Haushalts
heißt „nicht gefunden“ und führt zurück zum ersten eigenen Haushalt.

### 6. Reine Logik mit Tests (in `web/`)

- Sankey-Layout als Portierung von `apple/FreiraumKit/Sources/FreiraumKit/Sankey.swift`
  (Spalten nach längstem Weg, Senken in der letzten Spalte, ein Maßstab für alle Spalten,
  Reihenfolge wie von der API), mit Tests nach `SankeyTests.swift`.
- Die Aufbereitung aus `AnalyticsPresentation.swift` als Portierung, mit Tests nach
  `AnalyticsTests.swift`: Zeitraum und Verlauf, Kacheln samt Vergleichen (z. B. Sparquote gegen
  den Schnitt der Vormonate, Alter des Geldes gegen den Vormonat), Ziele, Besitz. Das sind
  Vergleiche zwischen Server-Werten, keine eigenen Kennzahl-Definitionen; Web und Mac zeigen so
  dasselbe (meine Wahl, statt neuer Backend-Felder).
- Zahlenformate wie in der Mac-App (`Money.swift` u. ä.), mit `Intl` in `de-DE`.
- Zeichnen (SVG) und Abruf sind dünn und werden im Browser geprüft, nicht per Unit-Test.

### 7. Image und CI

- Docker-Build-Kontext wird das Repo-Wurzelverzeichnis (`backend/Dockerfile` bleibt der Ort),
  mit neuer Stufe `web-build` (`pnpm install --frozen-lockfile && pnpm build` in `web/`),
  deren `dist/` ins Runtime-Image kopiert wird. Passende `.dockerignore`.
- `.github/workflows/backend.yml` (Image-Job) und `image-check.yml`: `context: .`,
  `file: backend/Dockerfile`, Pfadfilter um `web/**` erweitert.
- Neuer Workflow `web.yml` für `web/**` und `openapi/**`: lint, typecheck, test, build und die
  Prüfung, dass `schema.d.ts` aktuell ist.
- `deploy/README.md`: Hinweis auf die Web-Oberfläche unter `/` und auf `WEBAUTHN_ORIGINS`.

### 8. Dokumentation

- ADR 0007 „Web-Oberfläche“: Weg B, Cookie-Regeln, Auslieferung, CSP. ADR 0001 bekommt einen
  Verweis (der Satz „Für das Web kann später ein Cookie … dazukommen“ ist damit eingelöst).
- Spec: Plattformtabelle (Web: E6, umgesetzt) und Verweis auf ADR 0007.

## Dem Builder überlassen

- Komponentenschnitt in Preact, Zustandshaltung (Signals oder Hooks), Dateiaufteilung.
- Genaue Gestaltung im Rahmen des Entwurfs; Farben nur mit Bedeutung (Spec, Prinzip 6).
- Wie `cookieAuth` in den Routen ergänzt wird (Helfer oder je Route).
- Name und Ort des Schema-Aktualitäts-Tests.
- Ob der Verlauf eine eigene Anfrage mit 12 Monaten macht oder die Zeitraum-Anfrage mitnutzt.

## Browser und Abnahme (meine Wahl)

- Ziel sind Safari und Chrome in aktueller Version auf macOS. In Produktion läuft alles über
  HTTPS, der `__Host-`-Cookie ist dort in beiden unproblematisch. Browser ohne Trusted Types
  ignorieren die Direktive, nichts bricht.
- Geprüft wird beim Bauen automatisiert (Backend- und Web-Tests) und mit Chromium (Playwright) im
  Container: Seite lädt mit der echten CSP ohne Konsolenfehler, Anmeldeablauf mit einem
  virtuellen Authenticator gegen `localhost`. Ein zusätzlicher Dev-Schalter für den Cookie-Namen
  entfällt.
- Die Abnahme auf dem MacBook macht Ruben nach dem Merge und Deployment (Domain in
  `WEBAUTHN_ORIGINS` ist bereits die der Passkeys). FREI-7 steht bis dahin auf `review`; der PR
  enthält eine kurze Prüfliste dafür.

## Akzeptanz

- Auf dem MacBook: Passkey-Anmeldung unter `/`, nach Neuladen weiter angemeldet, Abmelden beendet
  die Sitzung (auch serverseitig).
- Alle sieben Bereiche zeigen die Zahlen der API für Haushalt, Monat und Zeitraum; Wechsel landen
  in der Adresse.
- Ein Cookie allein öffnet keinen schreibenden Endpunkt (Test), und Logout per Cookie geht nur mit
  passendem `Origin` (Test).
- Private Auswertungen der anderen Person bleiben 404, auch per Cookie (Test).
- Keine CSP- oder Trusted-Types-Meldung in der Browser-Konsole; keine Anfrage an fremde Hosts.
- Alle Gates in `backend/` und `web/` grün, `openapi.yaml` und `schema.d.ts` aktuell, das Image baut.
