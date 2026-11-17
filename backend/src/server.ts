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

const { app, auth, categorize } = createApp({ db, config })

const purge = setInterval(() => auth.purgeExpired().catch(console.error), 60 * 60 * 1000)
purge.unref()

if (config.llm) {
  console.log(`LLM-Vorschläge mit ${config.llm.model} über ${new URL(config.llm.baseUrl).host}`)
  // Vorschläge nachholen, die am Modell gescheitert sind oder bei einem Neustart liegen blieben.
  let retrying = false
  const retryLlm = async () => {
    if (retrying) return
    retrying = true
    try {
      await categorize.retryLlmSuggestions()
    } catch (err) {
      console.error('LLM-Vorschläge nachholen fehlgeschlagen', err)
    } finally {
      retrying = false
    }
  }
  void retryLlm()
  const retry = setInterval(retryLlm, 15 * 60 * 1000)
  retry.unref()
}

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
