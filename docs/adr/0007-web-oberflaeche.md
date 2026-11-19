# ADR 0007: Web-Oberfläche (E6)

Stand: 19.11.2026 · Status: vorgeschlagen (mit FREI-7) · Design: [Web-Auswertungen](../superpowers/specs/2026-11-19-web-auswertungen-design.md)

## Kontext

Die Spec sieht für E6 die Auswertungen im Browser vor, als Zugang ohne Installation. Genutzt wird
die Seite auf dem eigenen MacBook. Die Anmeldung darf deshalb über Neuladen und Tage hinweg
bestehen bleiben. ADR 0001 hält dafür ein Cookie mit demselben Sitzungsmodell offen. Rechnen soll
die Seite nichts: Die Kennzahlen kommen aus den E5-Endpunkten (ADR 0005), und die Privatsphäre
setzt der Server durch.

## Entscheidungen

### Eigenes Paket `web/`, ausgeliefert vom Backend

- Vite, TypeScript (strict) und Preact. Diagramme sind eigenes SVG, ohne Chart-Bibliothek. Es gibt
  keine Schriften oder Skripte von fremden Servern.
- `openapi-typescript` erzeugt die Client-Typen aus `openapi/openapi.yaml` (`pnpm gen`, die Datei
  `web/src/api/schema.d.ts` ist versioniert, ein Test prüft die Aktualität). Aufgerufen wird über
  `openapi-fetch`. Läuft die API auseinander, schlägt `pnpm typecheck` fehl, nicht erst der Browser.
- Die Aufbereitung (Zeitraum, Kacheln samt Vergleichen, Ziele, Besitz) und das Sankey-Layout sind
  Portierungen aus FreiraumKit (`AnalyticsPresentation.swift`, `Sankey.swift`, `Money.swift`), mit
  denselben Tests. Web und Mac zeigen damit dieselben Texte und Zahlen. Die Vergleiche (etwa
  Sparquote gegen den Schnitt davor) verrechnen nur Werte, die der Server geliefert hat.
- Das Backend-Image baut `web/` in einer eigenen Stufe. Der Build liegt neben `dist/` (`/app/web`),
  der Build-Kontext ist das Repo-Wurzelverzeichnis.
- Das Backend liest den Build beim Start (`WEB_DIST_DIR`, Standard `web/` neben `dist/`): `/`
  liefert `index.html` (`no-store`), `/assets/<datei>` nur Dateien, die beim Start gelistet wurden
  (`immutable`). Eine Anfrage berührt nie das Dateisystem. Es gelten dieselben Sicherheits-Header
  wie für `/registrieren`, auch `require-trusted-types-for 'script'`. Ohne Build führt `/` wie
  bisher zur Registrierung.
- Haushalt, Monat, Zeitraum und Umschalter stehen in der Adresse (`?haushalt=…&monat=…&zeitraum=…&fluss=…`),
  einen Client-Router gibt es nicht.

Verworfen:
- **Plain-JS ohne Build** wie `/registrieren`: Der generierte Client wäre nur ein Kommentar, und
  sechs Ansichten mit Zustand werden als DOM-Code zäh.
- **Eigenständiges Frontend als zweiter Container:** Das brächte eigenes Deployment, CORS, eine
  zweite Domain für die Passkeys und eine weichere CSP.

### Sitzung im Browser: HttpOnly-Cookie, nur lesend

- `POST /v1/auth/login/verify-web` prüft den Passkey wie `login/verify`. Das Token kommt aber nur
  als Cookie `__Host-freiraum_session` (`Path=/; Secure; HttpOnly; SameSite=Strict`,
  `Max-Age` = `SESSION_TTL_DAYS`), nie im Body. Skripte der Seite sehen es nicht.
- Sitzung, Hash und gleitender Ablauf sind dieselben wie beim Bearer-Token. `GET /v1/me` erneuert
  das Cookie bei Anmeldung per Cookie; die Seite ruft es bei jedem Laden.
- `requireAuth` nimmt das Cookie nur bei `GET`/`HEAD` an. Schreibende Routen bleiben Bearer-only,
  auch mit passendem `Origin`. `POST /v1/auth/logout` nimmt es zusätzlich an, wenn `Origin` in
  `WEBAUTHN_ORIGINS` steht, und löscht das Cookie. Ein Cookie kann damit nichts ändern; CSRF-Tokens
  braucht es nicht.
- Der Bearer-Header hat Vorrang vor dem Cookie. Die Apps ändern sich nicht.
- Im OpenAPI-Vertrag stehen lesende Routen mit `bearerAuth` oder `cookieAuth`, schreibende nur mit
  `bearerAuth`.

## Folgen

- Schreibende Funktionen im Browser (Bestätigen, Budget) brauchen später einen CSRF-Schutz oder
  ein anderes Modell; dieses ADR schließt sie bewusst aus.
- Lokal entwickeln: `pnpm dev` in `web/` leitet `/v1` an das Backend auf Port 3000 weiter.
  `WEBAUTHN_ORIGINS` braucht dann `http://localhost:5173`, `WEBAUTHN_RP_ID` ist `localhost`.
  Browser akzeptieren `Secure`-Cookies auf `http://localhost`.
- `web/` nutzt TypeScript 5.9, nicht 7 wie das Backend: `openapi-typescript` braucht die
  Programmierschnittstelle von TypeScript 5.
