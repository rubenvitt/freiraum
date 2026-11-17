import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { setupTestApp } from './helpers/app.js'

// Alle Namen und Beträge sind erfunden.

const { db, request, reset, personWithSession } = setupTestApp()

afterAll(() => db.end())
beforeEach(() => reset())

type Json = Record<string, any>
const body = async (res: Response): Promise<Json> => (await res.json()) as Json

async function setup(name = 'Person A') {
  const p = await personWithSession(name)
  const { items } = await body(await request('GET', '/v1/households', undefined, p.token))
  const householdId = items.find((h: Json) => h.kind === 'privat').id as string
  const cash = await body(
    await request('POST', '/v1/accounts', { householdId, name: 'Bargeld', source: 'bar' }, p.token),
  )
  const pot = await body(
    await request(
      'POST',
      `/v1/households/${householdId}/pots`,
      { name: 'Freizeit', kind: 'monatlich' },
      p.token,
    ),
  )
  return { ...p, householdId, cashId: cash.id as string, potId: pot.id as string }
}

const expense = (token: string, accountId: string, input: Json) =>
  request('POST', `/v1/accounts/${accountId}/cash-expenses`, input, token)

describe('Barausgabe erfassen', () => {
  it('legt eine bestätigte Ausgabe im Topf an und zählt im Budget', async () => {
    const a = await setup()
    const res = await expense(a.token, a.cashId, {
      clientId: randomUUID(),
      bookingDate: '2026-11-03',
      amountCents: 450,
      description: '  Bäcker ',
      potId: a.potId,
    })
    expect(res.status).toBe(201)
    const tx = await body(res)
    expect(tx).toMatchObject({
      accountId: a.cashId,
      bookingDate: '2026-11-03',
      amountCents: -450,
      counterpartyName: 'Bäcker',
      status: 'bestaetigt',
      splits: [{ kind: 'topf', potId: a.potId, amountCents: -450 }],
      suggestion: null,
    })

    const budget = await body(
      await request('GET', `/v1/households/${a.householdId}/budget/2026-11`, undefined, a.token),
    )
    const pot = budget.pots.find((p: Json) => p.potId === a.potId)
    expect(pot.activityCents).toBe(-450)
    expect(budget.unconfirmedTransactions).toBe(0)

    const pending = await body(await request('GET', '/v1/transactions/pending', undefined, a.token))
    expect(pending.items).toEqual([])
  })

  it('ist idempotent über clientId', async () => {
    const a = await setup()
    const input = {
      clientId: randomUUID(),
      bookingDate: '2026-11-03',
      amountCents: 1_200,
      potId: a.potId,
    }
    const first = await body(await expense(a.token, a.cashId, input))
    const again = await expense(a.token, a.cashId, { ...input, amountCents: 9_999 })
    expect(again.status).toBe(200)
    expect((await body(again)).id).toBe(first.id)

    const list = await body(
      await request('GET', `/v1/accounts/${a.cashId}/transactions`, undefined, a.token),
    )
    expect(list.items).toHaveLength(1)
    expect(list.items[0].amountCents).toBe(-1_200)
  })

  it('geht nur in Bargeldkonten', async () => {
    const a = await setup()
    const bank = await body(
      await request(
        'POST',
        '/v1/accounts',
        { householdId: a.householdId, name: 'Giro', source: 'bank' },
        a.token,
      ),
    )
    const res = await expense(a.token, bank.id, {
      clientId: randomUUID(),
      bookingDate: '2026-11-03',
      amountCents: 100,
      potId: a.potId,
    })
    expect(res.status).toBe(422)
    expect((await body(res)).error.code).toBe('kein_bargeldkonto')
  })

  it('lehnt Töpfe anderer Haushalte und Beträge ≤ 0 ab', async () => {
    const a = await setup('Person A')
    const b = await setup('Person B')
    const foreign = await expense(a.token, a.cashId, {
      clientId: randomUUID(),
      bookingDate: '2026-11-03',
      amountCents: 100,
      potId: b.potId,
    })
    expect(foreign.status).toBe(422)
    expect((await body(foreign)).error.code).toBe('topf_anderer_haushalt')

    const zero = await expense(a.token, a.cashId, {
      clientId: randomUUID(),
      bookingDate: '2026-11-03',
      amountCents: 0,
      potId: a.potId,
    })
    expect(zero.status).toBe(400)
  })

  it('verrät fremde Konten nicht', async () => {
    const a = await setup('Person A')
    const b = await setup('Person B')
    const res = await expense(b.token, a.cashId, {
      clientId: randomUUID(),
      bookingDate: '2026-11-03',
      amountCents: 100,
      potId: b.potId,
    })
    expect(res.status).toBe(404)
  })
})
