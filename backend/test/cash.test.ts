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

describe('Bargeldbestand', () => {
  async function withBank(name = 'Person A') {
    const a = await setup(name)
    const bank = await body(
      await request(
        'POST',
        '/v1/accounts',
        {
          householdId: a.householdId,
          name: 'Giro',
          source: 'bank',
          iban: 'DE89370400440532013000',
        },
        a.token,
      ),
    )
    return { ...a, bankId: bank.id as string }
  }

  const withdrawal = (bookingDate: string, amountCents = -5_000) => ({
    bookingDate,
    amountCents,
    counterpartyName: 'Geldautomat Beispielbank',
    purpose: `Bargeldauszahlung ${bookingDate}`,
  })

  async function importInto(token: string, accountId: string, transactions: Json[]) {
    const res = await request('POST', `/v1/accounts/${accountId}/imports`, { transactions }, token)
    expect(res.status).toBe(201)
    const list = await body(
      await request('GET', `/v1/accounts/${accountId}/transactions`, undefined, token),
    )
    return list.items as Json[]
  }

  const setSplits = (token: string, transactionId: string, splits: Json[]) =>
    request('PUT', `/v1/transactions/${transactionId}/splits`, { splits }, token)

  async function unrecorded(token: string, accountId: string) {
    const { items } = await body(await request('GET', '/v1/accounts', undefined, token))
    return items.find((x: Json) => x.id === accountId).unrecordedCashCents as number | null
  }

  const budget = async (token: string, householdId: string) =>
    body(await request('GET', `/v1/households/${householdId}/budget/2026-11`, undefined, token))

  it('zählt eine Abhebung ins Bargeldkonto, bis Ausgaben erfasst sind', async () => {
    const a = await withBank()
    expect(await unrecorded(a.token, a.cashId)).toBe(0)
    expect(await unrecorded(a.token, a.bankId)).toBeNull()

    const before = await budget(a.token, a.householdId)
    const [tx] = await importInto(a.token, a.bankId, [withdrawal('2026-11-02')])
    const res = await setSplits(a.token, tx?.id, [
      { kind: 'umbuchung', counterAccountId: a.cashId, amountCents: -5_000 },
    ])
    expect(res.status).toBe(200)
    expect((await body(res)).transaction.splits).toEqual([
      {
        kind: 'umbuchung',
        potId: null,
        personId: null,
        counterAccountId: a.cashId,
        amountCents: -5_000,
      },
    ])
    expect(await unrecorded(a.token, a.cashId)).toBe(5_000)

    // Die Abhebung ändert das Budget nicht.
    const afterWithdrawal = await budget(a.token, a.householdId)
    expect(afterWithdrawal.readyToAssignCents).toBe(before.readyToAssignCents)
    expect(afterWithdrawal.pots).toEqual(before.pots)

    await expense(a.token, a.cashId, {
      clientId: randomUUID(),
      bookingDate: '2026-11-03',
      amountCents: 2_000,
      potId: a.potId,
    })
    expect(await unrecorded(a.token, a.cashId)).toBe(3_000)

    // Erst die erfasste Ausgabe belastet den Topf.
    const afterExpense = await budget(a.token, a.householdId)
    expect(afterExpense.pots.find((p: Json) => p.potId === a.potId).activityCents).toBe(-2_000)
    expect(afterExpense.readyToAssignCents).toBe(before.readyToAssignCents)
  })

  it('lernt das Gegenkonto mit der Regel und schlägt die nächste Abhebung so vor', async () => {
    const a = await withBank()
    const [first] = await importInto(a.token, a.bankId, [withdrawal('2026-11-02')])
    const res = await setSplits(a.token, first?.id, [
      { kind: 'umbuchung', counterAccountId: a.cashId, amountCents: -5_000 },
    ])
    expect((await body(res)).rule).toMatchObject({
      kind: 'umbuchung',
      counterAccountId: a.cashId,
    })

    const items = await importInto(a.token, a.bankId, [withdrawal('2026-11-09', -3_000)])
    const second = items.find((t) => t.bookingDate === '2026-11-09')
    expect(second).toMatchObject({
      status: 'vorgeschlagen',
      splits: [{ kind: 'umbuchung', counterAccountId: a.cashId, amountCents: -3_000 }],
      suggestion: { source: 'regel', kind: 'umbuchung', counterAccountId: a.cashId },
    })
    // Ein Vorschlag zählt schon (wie im Budget).
    expect(await unrecorded(a.token, a.cashId)).toBe(8_000)
  })

  it('erkennt das Gegenkonto beim Abgleich über die IBAN', async () => {
    const a = await withBank()
    const savings = await body(
      await request(
        'POST',
        '/v1/accounts',
        {
          householdId: a.householdId,
          name: 'Tagesgeld',
          source: 'bank',
          iban: 'DE02120300000000202051',
        },
        a.token,
      ),
    )
    const [tx] = await importInto(a.token, a.bankId, [
      {
        bookingDate: '2026-11-04',
        amountCents: -10_000,
        counterpartyName: 'Person A',
        counterpartyIban: 'DE02120300000000202051',
        purpose: 'Sparen',
      },
    ])
    expect(tx?.suggestion).toMatchObject({
      source: 'abgleich',
      kind: 'umbuchung',
      counterAccountId: savings.id,
    })
  })

  it('prüft das Gegenkonto', async () => {
    const a = await withBank('Person A')
    const b = await setup('Person B')
    const [tx] = await importInto(a.token, a.bankId, [withdrawal('2026-11-02')])

    const notTransfer = await setSplits(a.token, tx?.id, [
      { kind: 'topf', potId: a.potId, counterAccountId: a.cashId, amountCents: -5_000 },
    ])
    expect(notTransfer.status).toBe(422)
    expect((await body(notTransfer)).error.code).toBe('ziel_ungueltig')

    const foreign = await setSplits(a.token, tx?.id, [
      { kind: 'umbuchung', counterAccountId: b.cashId, amountCents: -5_000 },
    ])
    expect(foreign.status).toBe(422)
    expect((await body(foreign)).error.code).toBe('gegenkonto_ungueltig')

    const self = await setSplits(a.token, tx?.id, [
      { kind: 'umbuchung', counterAccountId: a.bankId, amountCents: -5_000 },
    ])
    expect(self.status).toBe(422)
    expect((await body(self)).error.code).toBe('gegenkonto_ungueltig')

    // Person B sieht vom fremden Bestand nichts.
    expect(await unrecorded(b.token, b.cashId)).toBe(0)
  })
})
