import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { createDb } from './db/client.js'
import { migrate } from './db/migrate.js'

const config = loadConfig()
const db = createDb(config.databaseUrl)

if (config.migrateOnStart) {
  const applied = await migrate(db)
  if (applied.length > 0) console.log(`Migrationen angewendet: ${applied.join(', ')}`)
}

const { app, auth } = createApp({ db, config })

const purge = setInterval(() => auth.purgeExpired().catch(console.error), 60 * 60 * 1000)
purge.unref()

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Freiraum-Backend hört auf Port ${info.port} (RP-ID ${config.webauthn.rpId})`)
})

const shutdown = () => {
  server.close(async () => {
    await db.end({ timeout: 5 })
    process.exit(0)
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
