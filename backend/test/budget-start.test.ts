import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { addMonthsTo, monthOf } from '../src/budget/months.js'
import { todayUtc } from '../src/ledger/dates.js'
import { setupTestApp } from './helpers/app.js'

// Budgetbeginn und Anfangsbestand (FREI-13). Alle Namen, Beträge und IBANs sind erfunden.

const { db, ledger, request, reset, personWithSession } = setupTestApp()

afterAll(() => db.end())
beforeEach(() => reset())

type Json = Record<string, any>
const body = async (res: Response): Promise<Json> => (await res.json()) as Json

const current = monthOf(todayUtc())
const previous = addMonthsTo(current, -1)
const beforePrevious = addMonthsTo(current, -2)
const EMPLOYER_IBAN = 'DE89370400440532013000'

async function setup(name = 'Person A') {
  const p = await personWithSession(name)
  const { items } = await body(await request('GET', '/v1/households', undefined, p.token))
  const householdId = items.find((h: Json) => h.kind === 'privat').id as string
  const account = await body(
    await request('POST', '/v1/accounts', { householdId, name: 'Giro', source: 'bank' }, p.token),
  )
  // Regel „Arbeitgeber → Einnahme“, damit Gehälter ohne Bestätigung im Budget zählen.
  await request(
    'POST',
    `/v1/households/${householdId}/rules`,
    { counterpartyIban: EMPLOYER_IBAN, direction: 'eingang', kind: 'einnahme' },
    p.token,
  )
  return { ...p, householdId, accountId: account.id as string }
}

const startAt = (token: string, householdId: string, month: string) =>
  request('PUT', `/v1/households/${householdId}/budget-start`, { month }, token)

const getStart = (token: string, householdId: string) =>
  request('GET', `/v1/households/${householdId}/budget-start`, undefined, token)

const setBalance = (token: string, accountId: string, balanceCents: number, date: string) =>
  request('PUT', `/v1/accounts/${accountId}/balance`, { balanceCents, date }, token)

const month = async (token: string, householdId: string, m: string) =>
  body(await request('GET', `/v1/households/${householdId}/budget/${m}`, undefined, token))

const importInto = (token: string, accountId: string, transactions: Json[]) =>
  request('POST', `/v1/accounts/${accountId}/imports`, { transactions }, token)

const salary = (m: string, amountCents = 300_000) => ({
  bookingDate: `${m}-01`,
  amountCents,
  counterpartyName: 'Arbeitgeber Beispiel GmbH',
  counterpartyIban: EMPLOYER_IBAN,
  purpose: `Gehalt ${m}`,
})

const rent = (m: string) => ({
  bookingDate: `${m}-03`,
  amountCents: -100_000,
  counterpartyName: 'Vermietung Beispiel',
  purpose: `Miete ${m}`,
})

/** Zwei Jahre Historie bis einschließlich des laufenden Monats. */
const twoYears = () => {
  const rows: Json[] = []
  for (let i = 24; i >= 0; i--) {
    const m = addMonthsTo(current, -i)
    rows.push(salary(m), rent(m))
  }
  return rows
}

describe('Budgetbeginn', () => {
  it('beginnt bei neuen Haushalten im laufenden Monat', async () => {
    const a = await personWithSession('Person A')
    const b = await personWithSession('Person B')
    const shared = await ledger.createSharedHousehold('Gemeinsam', [a.person.id, b.person.id])
    const res = await getStart(a.token, shared.id)
    expect(res.status).toBe(200)
    expect(await body(res)).toMatchObject({
      householdId: shared.id,
      month: current,
      openingBalanceCents: 0,
      accounts: [],
    })
  })

  it('zählt bei zwei Jahren Historie nur Einnahmen ab dem Startmonat', async () => {
    const a = await setup()
    expect((await startAt(a.token, a.householdId, previous)).status).toBe(200)
    // Kontostand am 20. des Vormonats, nach Gehalt und Miete dieses Monats
    expect((await setBalance(a.token, a.accountId, 450_000, `${previous}-20`)).status).toBe(200)

    const imported = await importInto(a.token, a.accountId, twoYears())
    expect(imported.status).toBe(201)
    expect((await body(imported)).imported).toBe(50)

    const start = await body(await getStart(a.token, a.householdId))
    // Stand zu Monatsbeginn = 450.000 − (300.000 − 100.000)
    expect(start).toMatchObject({
      month: previous,
      openingBalanceCents: 250_000,
      accounts: [
        {
          accountId: a.accountId,
          name: 'Giro',
          balance: { cents: 450_000, date: `${previous}-20`, source: 'manuell' },
          openingBalanceCents: 250_000,
        },
      ],
    })

    const first = await month(a.token, a.householdId, previous)
    expect(first).toMatchObject({
      budgetStartMonth: previous,
      openingBalanceCents: 250_000,
      inflowsCents: 300_000,
      readyToAssignCents: 550_000,
    })
    const now = await month(a.token, a.householdId, current)
    expect(now).toMatchObject({ openingBalanceCents: 0, readyToAssignCents: 850_000 })

    // Vor dem Start ist das Budget leer.
    expect(await month(a.token, a.householdId, beforePrevious)).toMatchObject({
      budgetStartMonth: previous,
      openingBalanceCents: 0,
      inflowsCents: 0,
      readyToAssignCents: 0,
      unconfirmedTransactions: 0,
    })

    // Alte Buchungen bleiben erhalten, bekommen aber keine Vorschläge.
    const [counts] = await db<{ before: number; suggested_before: number; pending: number }[]>`
      select
        count(*) filter (where t.booking_date < ${`${previous}-01`})::int as before,
        count(*) filter (where t.booking_date < ${`${previous}-01`}
                         and t.status <> 'importiert')::int as suggested_before,
        count(*) filter (where t.booking_date >= ${`${previous}-01`})::int as pending
      from transactions t where t.account_id = ${a.accountId}
    `
    expect(counts).toEqual({ before: 46, suggested_before: 0, pending: 4 })
    const pending = await body(await request('GET', '/v1/transactions/pending', undefined, a.token))
    expect(pending.items).toHaveLength(4)
    // Serienerkennung sieht weiter die ganze Historie.
    const recurring = await body(await request('GET', '/v1/recurring', undefined, a.token))
    expect(recurring.items.some((s: Json) => s.occurrences === 25)).toBe(true)
  })

  it('legt keine Erst-ich-Zuweisungen vor dem Startmonat an', async () => {
    const a = await setup()
    await startAt(a.token, a.householdId, previous)
    await setBalance(a.token, a.accountId, 100_000, `${beforePrevious}-28`)
    const share = await body(
      await request(
        'POST',
        `/v1/households/${a.householdId}/pots`,
        { name: 'Erst ich', kind: 'erst_ich', percentBp: 1000 },
        a.token,
      ),
    )
    await importInto(a.token, a.accountId, twoYears())

    const rows = await db<{ month: string; amount_cents: string; source: string }[]>`
      select to_char(month, 'YYYY-MM') as month, amount_cents, source from pot_assignments
      where pot_id = ${share.id} order by month
    `
    // 10 % des Gehalts, nicht des Anfangsbestands; nichts vor dem Start.
    expect(rows.map((r) => [r.month, Number(r.amount_cents), r.source])).toEqual([
      [previous, 30_000, 'automatik'],
      [current, 30_000, 'automatik'],
    ])

    const manual = await request(
      'PUT',
      `/v1/households/${a.householdId}/budget/${beforePrevious}/pots/${share.id}`,
      { assignedCents: 1_000 },
      a.token,
    )
    expect(manual.status).toBe(409)
    expect((await body(manual)).error.code).toBe('vor_budgetbeginn')
    const fill = await request(
      'POST',
      `/v1/households/${a.householdId}/budget/${beforePrevious}/erst-ich`,
      undefined,
      a.token,
    )
    expect(fill.status).toBe(409)
  })

  it('füllt Erst-ich aus dem Anfangsbestand, sobald der Kontostand bekannt ist', async () => {
    const a = await setup()
    await startAt(a.token, a.householdId, current)
    const fixed = await body(
      await request(
        'POST',
        `/v1/households/${a.householdId}/pots`,
        { name: 'Sparen', kind: 'erst_ich', amountCents: 50_000 },
        a.token,
      ),
    )
    let view = await month(a.token, a.householdId, current)
    expect(view.pots.find((p: Json) => p.potId === fixed.id).assignedCents).toBe(0)

    await setBalance(a.token, a.accountId, 80_000, `${previous}-28`)
    view = await month(a.token, a.householdId, current)
    expect(view.openingBalanceCents).toBe(80_000)
    expect(view.pots.find((p: Json) => p.potId === fixed.id)).toMatchObject({
      assignedCents: 50_000,
      assignmentSource: 'automatik',
    })
    expect(view.readyToAssignCents).toBe(30_000)
  })

  it('schließt erst ab dem Startmonat ab und hält den Start danach fest', async () => {
    const a = await setup()
    await startAt(a.token, a.householdId, previous)
    await importInto(a.token, a.accountId, [salary(beforePrevious), salary(previous)])
    const pending = await body(await request('GET', '/v1/transactions/pending', undefined, a.token))
    expect(pending.items).toHaveLength(1)
    await request('POST', `/v1/transactions/${pending.items[0].id}/confirm`, undefined, a.token)

    const close = (m: string) =>
      request('POST', `/v1/households/${a.householdId}/budget/${m}/closing`, undefined, a.token)
    const early = await close(beforePrevious)
    expect(early.status).toBe(409)
    expect((await body(early)).error.code).toBe('vor_budgetbeginn')
    // Der Startmonat ist der erste, es gibt keinen offenen Vormonat.
    expect((await close(previous)).status).toBe(201)

    const moved = await startAt(a.token, a.householdId, beforePrevious)
    expect(moved.status).toBe(409)
    expect((await body(moved)).error.code).toBe('budgetbeginn_fest')
  })

  it('verschiebt den Start nur ohne eigene Zuweisungen davor', async () => {
    const a = await setup()
    await startAt(a.token, a.householdId, beforePrevious)
    await importInto(a.token, a.accountId, [salary(beforePrevious), salary(previous)])
    const essen = await body(
      await request(
        'POST',
        `/v1/households/${a.householdId}/pots`,
        { name: 'Essen', kind: 'monatlich' },
        a.token,
      ),
    )
    const share = await body(
      await request(
        'POST',
        `/v1/households/${a.householdId}/pots`,
        { name: 'Erst ich', kind: 'erst_ich', amountCents: 10_000 },
        a.token,
      ),
    )
    await request(
      'POST',
      `/v1/households/${a.householdId}/budget/${beforePrevious}/erst-ich`,
      undefined,
      a.token,
    )
    const assign = (cents: number) =>
      request(
        'PUT',
        `/v1/households/${a.householdId}/budget/${beforePrevious}/pots/${essen.id}`,
        { assignedCents: cents },
        a.token,
      )
    expect((await assign(20_000)).status).toBe(200)

    const blocked = await startAt(a.token, a.householdId, previous)
    expect(blocked.status).toBe(409)
    expect((await body(blocked)).error.code).toBe('zuweisungen_vor_budgetbeginn')

    expect((await assign(0)).status).toBe(200)
    expect((await startAt(a.token, a.householdId, previous)).status).toBe(200)
    // Automatik- und 0-Zuweisungen vor dem neuen Start sind weg.
    const rows = await db<{ pot_id: string; month: string }[]>`
      select pot_id, to_char(month, 'YYYY-MM') as month from pot_assignments
      where pot_id = any(${[essen.id, share.id]}::uuid[]) and month < ${`${previous}-01`}
    `
    expect(rows).toEqual([])
  })

  it('macht Vorschläge, wenn der Start nach vorn rückt', async () => {
    const a = await setup()
    await startAt(a.token, a.householdId, current)
    await importInto(a.token, a.accountId, [salary(beforePrevious), salary(previous)])
    const before = await body(await request('GET', '/v1/transactions/pending', undefined, a.token))
    expect(before.items).toHaveLength(0)

    const moved = await startAt(a.token, a.householdId, beforePrevious)
    expect(moved.status).toBe(200)
    expect((await body(moved)).month).toBe(beforePrevious)
    const after = await body(await request('GET', '/v1/transactions/pending', undefined, a.token))
    expect(after.items.map((t: Json) => t.status)).toEqual(['vorgeschlagen', 'vorgeschlagen'])
    expect((await month(a.token, a.householdId, previous)).readyToAssignCents).toBe(600_000)
  })

  it('prüft Kontostände und hält fremde Haushalte verborgen', async () => {
    const a = await setup('Person A')
    const b = await setup('Person B')

    const future = await setBalance(a.token, a.accountId, 1_000, `${addMonthsTo(current, 1)}-01`)
    expect(future.status).toBe(422)
    expect((await body(future)).error.code).toBe('kontostand_in_zukunft')

    expect((await setBalance(b.token, a.accountId, 1_000, `${previous}-01`)).status).toBe(404)
    expect((await getStart(b.token, a.householdId)).status).toBe(404)
    expect((await startAt(b.token, a.householdId, previous)).status).toBe(404)

    expect((await setBalance(a.token, a.accountId, -2_500, `${previous}-01`)).status).toBe(200)
    const accounts = await body(await request('GET', '/v1/accounts', undefined, a.token))
    expect(accounts.items[0].balance).toEqual({
      cents: -2_500,
      date: `${previous}-01`,
      source: 'manuell',
    })
  })
})
