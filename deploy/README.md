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

Die Ausgabe enthält ein einmaliges Einladungs-Token (`fre_…`, 72 Stunden gültig). Damit
registriert die App bzw. der Browser den ersten Passkey. Weitere Geräte oder Wiederherstellung:

```bash
docker compose exec backend node dist/cli.js personen
```

```bash
docker compose exec backend node dist/cli.js einladen <Person-ID>
```

Tokens nicht in Chats oder Tickets ablegen; am besten direkt am Gerät eingeben.

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
