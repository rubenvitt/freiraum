import { createApp } from '../../src/app.js'
import type { Config } from '../../src/config.js'
import { createDb, type Db } from '../../src/db/client.js'
import { TEST_DATABASE_URL } from './env.js'

export const ORIGIN = 'https://freiraum.test'

export const testConfig: Config = {
  port: 0,
  databaseUrl: TEST_DATABASE_URL,
  webauthn: { rpId: 'freiraum.test', rpName: 'Freiraum Test', origins: [ORIGIN] },
  appleAppIds: ['ABCDE12345.dev.example.freiraum'],
  sessionTtlDays: 90,
  invitationTtlHours: 72,
  migrateOnStart: false,
}

export function setupTestApp() {
  const db: Db = createDb(TEST_DATABASE_URL)
  const { app, auth } = createApp({ db, config: testConfig })

  const request = (method: string, path: string, body?: unknown, token?: string) =>
    app.request(path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

  const reset = () =>
    db`truncate persons, invitations, passkeys, webauthn_challenges, sessions cascade`

  return { db, app, auth, request, reset }
}
