# Deployment auf dem Homelab

Voraussetzungen: Docker mit Compose, ein Reverse Proxy mit TLS (z. B. Caddy oder Traefik) und eine
feste Domain für das Backend. Diese Domain ist zugleich die RP-ID der Passkeys und darf sich
später nicht mehr ändern.

## Erstes Aufsetzen

1. Ordner `deploy/` auf den Server kopieren (oder Repo klonen).
2. `cp .env.example .env` und ausfüllen: langes `POSTGRES_PASSWORD`, `WEBAUTHN_RP_ID`,
   später `APPLE_APP_IDS` für die Apps.
3. Starten:

   ```bash
   docker compose up -d
   ```

4. Reverse Proxy auf `127.0.0.1:3000` zeigen lassen (Port über `FREIRAUM_PORT` änderbar).
5. Prüfen:

   ```bash
   curl https://<domain>/health
   ```

## Personen einladen

Es gibt kein öffentliches Sign-up. Für jede Person einmal:

```bash
docker compose exec backend node dist/cli.js person-anlegen "Name"
```

Die Ausgabe enthält ein einmaliges Einladungs-Token (`fre_…`, 72 Stunden gültig) und einen Link
`https://<domain>/registrieren#token=fre_…`. Das Token steht im Fragment (`#…`) und geht damit nie
an den Server oder in Logs.

### Passkey im Browser anlegen

1. `https://<domain>/registrieren` im Safari auf dem iPhone oder Mac öffnen (`/` leitet dorthin
   weiter). Den Link aus der Ausgabe öffnen oder das Token einfügen.
2. „Passkey anlegen“ → Face ID / Touch ID bestätigen → „Passkey angelegt für <Name>“.
   Die Einladung ist damit verbraucht. Der Passkey liegt im iCloud-Schlüsselbund und steht so
   auch auf den anderen Apple-Geräten der Person bereit.
3. „Anmelden testen“ zeigt nach Face ID / Touch ID den eigenen Namen. Die Sitzungen, die dabei
   entstehen, beendet die Seite sofort wieder; sie speichert nichts im Browser.
4. Kontrolle auf dem Server:

   ```bash
   docker compose exec backend node dist/cli.js personen
   ```

Die Seite funktioniert nur über die Domain aus `WEBAUTHN_RP_ID` (bzw. eine Subdomain davon, die in
`WEBAUTHN_ORIGINS` steht) und nur per HTTPS. Unter einer anderen Adresse meldet sie das.

### Weitere Geräte und Wiederherstellung

Gleiche Seite, neue Einladung:

```bash
docker compose exec backend node dist/cli.js einladen <Person-ID>
```

Die Person-ID zeigt `cli personen`. Tokens nicht in Chats oder Tickets ablegen; am besten den Link
per AirDrop schicken oder das Token direkt am Gerät eingeben.

## Aktualisieren

```bash
docker compose pull && docker compose up -d
```

Migrationen laufen beim Start automatisch.

## Passkeys in den Apps

Die iOS- und macOS-App brauchen Associated Domains (`webcredentials:<domain>`). Das Backend
liefert `/.well-known/apple-app-site-association` aus, sobald `APPLE_APP_IDS` gesetzt ist
(Format `TEAMID.bundle.id`, mehrere mit Komma). Die Bundle-ID der App ist
`<FREIRAUM_BUNDLE_PREFIX>.freiraum`, siehe [`apple/README.md`](../apple/README.md).
