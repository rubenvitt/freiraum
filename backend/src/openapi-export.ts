/**
 * Schreibt den OpenAPI-Vertrag nach ../openapi/openapi.yaml.
 * Die Datei ist versioniert; CI prüft, dass sie zum Code passt.
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'
import { createApp, openApiInfo } from './app.js'
import type { Config } from './config.js'
import { createDb } from './db/client.js'

const config: Config = {
  port: 0,
  databaseUrl: 'postgres://unbenutzt@localhost/unbenutzt',
  webauthn: { rpId: 'freiraum.example', rpName: 'Freiraum', origins: [] },
  appleAppIds: [],
  sessionTtlDays: 90,
  invitationTtlHours: 72,
  migrateOnStart: false,
  llm: null,
}

// postgres.js verbindet erst bei der ersten Abfrage; hier wird keine gestellt.
const db = createDb(config.databaseUrl)
const { app } = createApp({ db, config })
const doc = app.getOpenAPI31Document(openApiInfo)

const target = fileURLToPath(new URL('../../openapi/openapi.yaml', import.meta.url))
await writeFile(
  target,
  `# Erzeugt von backend/src/openapi-export.ts – nicht von Hand ändern.\n${stringify(doc, { lineWidth: 0 })}`,
)
await db.end()
console.log(`OpenAPI geschrieben: ${target}`)
