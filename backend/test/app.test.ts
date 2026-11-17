import { readdir, readFile } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { openApiInfo } from '../src/app.js'
import { migrate } from '../src/db/migrate.js'
import { setupTestApp } from './helpers/app.js'

const { db, app, request } = setupTestApp()
afterAll(() => db.end())

describe('Betrieb', () => {
  it('meldet Dienst und Datenbank als gesund', async () => {
    const res = await request('GET', '/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', database: 'ok' })
  })

  it('liefert apple-app-site-association für Passkeys in den Apps', async () => {
    const res = await request('GET', '/.well-known/apple-app-site-association')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      webcredentials: { apps: ['ABCDE12345.dev.example.freiraum'] },
    })
  })

  it('migriert idempotent', async () => {
    expect(await migrate(db)).toEqual([])
  })
})

describe('OpenAPI-Vertrag', () => {
  it('wird unter /openapi.json ausgeliefert', async () => {
    const res = await request('GET', '/openapi.json')
    expect(res.status).toBe(200)
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> }
    expect(doc.openapi).toBe('3.1.0')
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/health',
      '/v1/accounts',
      '/v1/accounts/{accountId}/balance',
      '/v1/accounts/{accountId}/cash-expenses',
      '/v1/accounts/{accountId}/imports',
      '/v1/accounts/{accountId}/transactions',
      '/v1/assets/{assetId}',
      '/v1/auth/login/options',
      '/v1/auth/login/verify',
      '/v1/auth/logout',
      '/v1/auth/registration/options',
      '/v1/auth/registration/verify',
      '/v1/households',
      '/v1/households/{householdId}/analytics/anomalies',
      '/v1/households/{householdId}/analytics/flow',
      '/v1/households/{householdId}/analytics/goals',
      '/v1/households/{householdId}/analytics/metrics',
      '/v1/households/{householdId}/analytics/ownership-costs',
      '/v1/households/{householdId}/assets',
      '/v1/households/{householdId}/budget-start',
      '/v1/households/{householdId}/budget/{month}',
      '/v1/households/{householdId}/budget/{month}/closing',
      '/v1/households/{householdId}/budget/{month}/erst-ich',
      '/v1/households/{householdId}/budget/{month}/pots/{potId}',
      '/v1/households/{householdId}/contribution-rules',
      '/v1/households/{householdId}/contribution-rules/{month}',
      '/v1/households/{householdId}/contributions/{month}',
      '/v1/households/{householdId}/pot-order',
      '/v1/households/{householdId}/pots',
      '/v1/households/{householdId}/rules',
      '/v1/households/{householdId}/settlements',
      '/v1/me',
      '/v1/persons/{personId}/analytics/flow',
      '/v1/persons/{personId}/metrics/{month}',
      '/v1/pots/{potId}',
      '/v1/recurring',
      '/v1/rules/{ruleId}',
      '/v1/settlements/{settlementId}',
      '/v1/shares',
      '/v1/shares/{personId}/{scope}',
      '/v1/transactions/pending',
      '/v1/transactions/{transactionId}/confirm',
      '/v1/transactions/{transactionId}/splits',
    ])
  })

  it('stimmt mit openapi/openapi.yaml im Repo überein (sonst: pnpm openapi)', async () => {
    const committed = await readFile(new URL('../../openapi/openapi.yaml', import.meta.url), 'utf8')
    const generated = stringify(app.getOpenAPI31Document(openApiInfo), { lineWidth: 0 })
    expect(committed.slice(committed.indexOf('\n') + 1)).toBe(generated)
  })

  it('vergibt jeden Schemanamen nur einmal (sonst überschreibt einer still den anderen)', async () => {
    const dir = new URL('../src/routes/', import.meta.url)
    const names: string[] = []
    for (const file of await readdir(dir)) {
      const source = await readFile(new URL(file, dir), 'utf8')
      for (const m of source.matchAll(/\.openapi\('([A-Za-z0-9]+)'\)/g)) names.push(m[1] as string)
    }
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([])
  })
})
