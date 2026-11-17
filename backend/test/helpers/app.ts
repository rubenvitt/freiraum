import { createApp } from '../../src/app.js'
import { hashToken, newToken } from '../../src/auth/tokens.js'
import type { LlmCategorizer } from '../../src/categorize/llm.js'
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

export function setupTestApp(options: { llm?: LlmCategorizer } = {}) {
  const db: Db = createDb(TEST_DATABASE_URL)
  const { app, auth, budget, categorize, ledger } = createApp({
    db,
    config: testConfig,
    llm: options.llm ?? null,
  })

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

  /** Person mit Sitzung anlegen, ohne Passkey-Ablauf (der ist in auth.test.ts geprüft). */
  const personWithSession = async (name: string) => {
    const person = await auth.createPerson(name)
    const token = newToken('frs')
    await db`
      insert into sessions (person_id, token_hash, expires_at)
      values (${person.id}, ${hashToken(token)}, now() + interval '1 day')
    `
    return { person, token }
  }

  return { db, app, auth, budget, categorize, ledger, request, reset, personWithSession }
}
