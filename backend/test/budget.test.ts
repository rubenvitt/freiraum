import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { addMonthsTo, monthOf } from '../src/budget/months.js'
import { todayUtc } from '../src/ledger/dates.js'
import { setupTestApp } from './helpers/app.js'

// Alle Namen, Beträge und IBANs sind erfunden.

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
  return { ...p, householdId, accountId: account.id as string }
}

const createPot = async (token: string, householdId: string, input: Json) =>
  request('POST', `/v1/households/${householdId}/pots`, input, token)

async function potId(token: string, householdId: string, input: Json): Promise<string> {
  const res = await createPot(token, householdId, input)
  expect(res.status).toBe(201)
  return (await body(res)).id
}

const month = (token: string, householdId: string, m: string) =>
  request('GET', `/v1/households/${householdId}/budget/${m}`, undefined, token)

const assign = (token: string, householdId: string, m: string, pot: string, cents: number) =>
  request(
    'PUT',
    `/v1/households/${householdId}/budget/${m}/pots/${pot}`,
    { assignedCents: cents },
    token,
  )

const salary = (m: string, amountCents = 300_000) => ({
  bookingDate: `${m}-01`,
  amountCents,
  counterpartyName: 'Arbeitgeber Beispiel GmbH',
  counterpartyIban: EMPLOYER_IBAN,
  purpose: `Gehalt ${m}`,
})

/** Regel „Arbeitgeber → Einnahme“, damit Gehälter ohne Bestätigung im Budget zählen. */
const salaryRule = (token: string, householdId: string) =>
  request(
    'POST',
    `/v1/households/${householdId}/rules`,
    { counterpartyIban: EMPLOYER_IBAN, direction: 'eingang', kind: 'einnahme' },
    token,
  )

/** Budgetbeginn setzen (Abschlüsse laufen ab dem Startmonat der Reihe nach). */
async function startAt(token: string, householdId: string, m: string) {
  const res = await request(
    'PUT',
    `/v1/households/${householdId}/budget-start`,
    { month: m },
    token,
  )
  expect(res.status).toBe(200)
}

const importInto = (token: string, accountId: string, transactions: Json[]) =>
  request('POST', `/v1/accounts/${accountId}/imports`, { transactions }, token)

describe('Töpfe', () => {
  it('legt Töpfe aller Typen an und listet sie in Reihenfolge', async () => {
    const a = await setup()
    await potId(a.token, a.householdId, {
      name: 'Lebensmittel',
      kind: 'monatlich',
      amountCents: 40_000,
      groupName: 'Alltag',
      sortOrder: 2,
    })
    await potId(a.token, a.householdId, {
      name: 'Kfz-Versicherung',
      kind: 'ruecklage',
      amountCents: 60_000,
      sortOrder: 3,
    })
    await potId(a.token, a.householdId, {
      name: 'Neues Fahrrad',
      kind: 'ziel',
      amountCents: 150_000,
      targetMonth: addMonthsTo(current, 5),
      sortOrder: 4,
    })
    await potId(a.token, a.householdId, {
      name: 'Investieren',
      kind: 'erst_ich',
      percentBp: 1_000,
      sortOrder: 1,
    })
    const res = await request('GET', `/v1/households/${a.householdId}/pots`, undefined, a.token)
    expect(res.status).toBe(200)
    const { items } = await body(res)
    expect(items.map((p: Json) => [p.name, p.kind])).toEqual([
      ['Investieren', 'erst_ich'],
      ['Lebensmittel', 'monatlich'],
      ['Kfz-Versicherung', 'ruecklage'],
      ['Neues Fahrrad', 'ziel'],
    ])
    expect(items[1]).toMatchObject({ groupName: 'Alltag', amountCents: 40_000, archived: false })
  })

  it('prüft den Plan je Typ und doppelte Namen', async () => {
    const a = await setup()
    const cases: [Json, string][] = [
      [{ name: 'X', kind: 'ruecklage' }, 'topf_plan_ungueltig'],
      [{ name: 'X', kind: 'ziel', targetMonth: current }, 'topf_plan_ungueltig'],
      [{ name: 'X', kind: 'erst_ich' }, 'topf_plan_ungueltig'],
      [{ name: 'X', kind: 'erst_ich', amountCents: 1, percentBp: 1 }, 'topf_plan_ungueltig'],
      [{ name: 'X', kind: 'monatlich', percentBp: 100 }, 'topf_plan_ungueltig'],
    ]
    for (const [input, code] of cases) {
      const res = await createPot(a.token, a.householdId, input)
      expect(res.status).toBe(422)
      expect((await body(res)).error.code).toBe(code)
    }
    await potId(a.token, a.householdId, { name: 'Essen', kind: 'monatlich' })
    const dup = await createPot(a.token, a.householdId, { name: 'essen', kind: 'monatlich' })
    expect(dup.status).toBe(409)
    const badMonth = await createPot(a.token, a.householdId, {
      name: 'Y',
      kind: 'ziel',
      amountCents: 100,
      targetMonth: '2026-13',
    })
    expect(badMonth.status).toBe(400)
  })

  it('hält fremde Haushalte und Töpfe verborgen', async () => {
    const a = await setup('Person A')
    const b = await setup('Person B')
    const pot = await potId(a.token, a.householdId, { name: 'Privat', kind: 'monatlich' })
    expect((await createPot(b.token, a.householdId, { name: 'X', kind: 'monatlich' })).status).toBe(
      404,
    )
    expect(
      (await request('GET', `/v1/households/${a.householdId}/pots`, undefined, b.token)).status,
    ).toBe(404)
    expect((await month(b.token, a.householdId, current)).status).toBe(404)
    expect((await request('PATCH', `/v1/pots/${pot}`, { name: 'Y' }, b.token)).status).toBe(404)
    expect((await assign(b.token, a.householdId, current, pot, 1)).status).toBe(404)
    // Eigener Haushalt, fremder Topf
    expect((await assign(b.token, b.householdId, current, pot, 0)).status).toBe(404)
  })

  it('teilt Töpfe des gemeinsamen Haushalts mit beiden', async () => {
    const a = await setup('Person A')
    const b = await setup('Person B')
    const shared = await ledger.createSharedHousehold('Gemeinsam', [a.person.id, b.person.id])
    const pot = await potId(a.token, shared.id, { name: 'Miete', kind: 'monatlich' })
    const forB = await body(
      await request('GET', `/v1/households/${shared.id}/pots`, undefined, b.token),
    )
    expect(forB.items.map((p: Json) => p.id)).toEqual([pot])
  })

  it('archiviert nur leere Töpfe', async () => {
    const a = await setup()
    await salaryRule(a.token, a.householdId)
    await importInto(a.token, a.accountId, [salary(current)])
    const pot = await potId(a.token, a.householdId, { name: 'Kino', kind: 'monatlich' })
    await assign(a.token, a.householdId, current, pot, 1_000)
    const full = await request('PATCH', `/v1/pots/${pot}`, { archived: true }, a.token)
    expect(full.status).toBe(409)
    expect((await body(full)).error.code).toBe('topf_nicht_leer')
    await assign(a.token, a.householdId, current, pot, 0)
    const ok = await request('PATCH', `/v1/pots/${pot}`, { archived: true }, a.token)
    expect(ok.status).toBe(200)
    expect((await body(ok)).archived).toBe(true)
    const list = await body(
      await request('GET', `/v1/households/${a.householdId}/pots`, undefined, a.token),
    )
    expect(list.items).toEqual([])
    const withArchived = await body(
      await request(
        'GET',
        `/v1/households/${a.householdId}/pots?includeArchived=true`,
        undefined,
        a.token,
      ),
    )
    expect(withArchived.items).toHaveLength(1)
    // Einem archivierten Topf wird nichts mehr zugewiesen.
    const res = await assign(a.token, a.householdId, current, pot, 100)
    expect(res.status).toBe(422)
  })
})

describe('Zuweisungen und „Noch ohne Aufgabe“', () => {
  it('verteilt nur Geld, das da ist', async () => {
    const a = await setup()
    const essen = await potId(a.token, a.householdId, { name: 'Essen', kind: 'monatlich' })
    const miete = await potId(a.token, a.householdId, { name: 'Miete', kind: 'monatlich' })

    // Ohne Einnahmen lässt sich nichts zuweisen.
    const none = await assign(a.token, a.householdId, current, essen, 1)
    expect(none.status).toBe(422)
    expect((await body(none)).error.code).toBe('noch_ohne_aufgabe_negativ')

    await salaryRule(a.token, a.householdId)
    await importInto(a.token, a.accountId, [salary(current, 200_000)])

    const first = await assign(a.token, a.householdId, current, miete, 120_000)
    expect(first.status).toBe(200)
    expect((await body(first)).readyToAssignCents).toBe(80_000)

    const tooMuch = await assign(a.token, a.householdId, current, essen, 80_001)
    expect(tooMuch.status).toBe(422)
    const exact = await body(await assign(a.token, a.householdId, current, essen, 80_000))
    expect(exact.readyToAssignCents).toBe(0)

    // Auch nicht über den Folgemonat: dort ist dasselbe Geld schon vergeben.
    const next = await assign(a.token, a.householdId, addMonthsTo(current, 1), essen, 1)
    expect(next.status).toBe(422)

    // Senken geht immer.
    const lower = await body(await assign(a.token, a.householdId, current, miete, 100_000))
    expect(lower.readyToAssignCents).toBe(20_000)
    expect(lower.pots.find((p: Json) => p.potId === miete)).toMatchObject({
      assignedCents: 100_000,
      assignmentSource: 'manuell',
      availableCents: 100_000,
    })
  })

  it('zeigt Ausgaben, Übertrag und Überziehung im Monat', async () => {
    const a = await setup()
    await salaryRule(a.token, a.householdId)
    const essen = await potId(a.token, a.householdId, {
      name: 'Essen',
      kind: 'monatlich',
      amountCents: 50_000,
    })
    await importInto(a.token, a.accountId, [
      salary(previous, 100_000),
      { bookingDate: `${previous}-10`, amountCents: -60_000, counterpartyName: 'Markt Beispiel' },
    ])
    // Ausgabe dem Topf zuordnen
    const pending = await body(await request('GET', '/v1/transactions/pending', undefined, a.token))
    const purchase = pending.items.find((t: Json) => t.amountCents === -60_000)
    await request(
      'PUT',
      `/v1/transactions/${purchase.id}/splits`,
      { splits: [{ kind: 'topf', potId: essen, amountCents: -60_000 }] },
      a.token,
    )
    await assign(a.token, a.householdId, previous, essen, 50_000)

    const prev = await body(await month(a.token, a.householdId, previous))
    expect(prev).toMatchObject({ inflowsCents: 100_000, readyToAssignCents: 50_000 })
    expect(prev.pots[0]).toMatchObject({
      activityCents: -60_000,
      availableCents: -10_000,
      planCents: 50_000,
      neededCents: 0,
    })

    const now = await body(await month(a.token, a.householdId, current))
    expect(now).toMatchObject({
      overspentPreviousCents: 10_000,
      readyToAssignCents: 40_000,
      inflowsCents: 0,
    })
    expect(now.pots[0]).toMatchObject({ carryoverCents: 0, availableCents: 0, neededCents: 50_000 })
  })
})

describe('Erst-ich-Automatik', () => {
  it('füllt Erst-ich-Töpfe nach dem Gehaltseingang', async () => {
    const a = await setup()
    await salaryRule(a.token, a.householdId)
    const invest = await potId(a.token, a.householdId, {
      name: 'Investieren',
      kind: 'erst_ich',
      percentBp: 1_500,
      sortOrder: 1,
    })
    const reserve = await potId(a.token, a.householdId, {
      name: 'Notgroschen',
      kind: 'erst_ich',
      amountCents: 20_000,
      sortOrder: 2,
    })

    await importInto(a.token, a.accountId, [salary(current, 300_000)])
    const view = await body(await month(a.token, a.householdId, current))
    const byId = Object.fromEntries(view.pots.map((p: Json) => [p.potId, p]))
    expect(byId[invest]).toMatchObject({ assignedCents: 45_000, assignmentSource: 'automatik' })
    expect(byId[reserve]).toMatchObject({ assignedCents: 20_000, assignmentSource: 'automatik' })
    expect(view.readyToAssignCents).toBe(235_000)

    // Zweites Gehalt im selben Monat: der Anteil wächst mit.
    await importInto(a.token, a.accountId, [
      { ...salary(current, 100_000), bookingDate: `${current}-15`, purpose: 'Bonus' },
    ])
    const after = await body(await month(a.token, a.householdId, current))
    expect(after.pots.find((p: Json) => p.potId === invest).assignedCents).toBe(60_000)

    // Eigene Zuweisung schaltet die Automatik für diesen Topf und Monat ab.
    await assign(a.token, a.householdId, current, invest, 10_000)
    const manual = await body(
      await request(
        'POST',
        `/v1/households/${a.householdId}/budget/${current}/erst-ich`,
        undefined,
        a.token,
      ),
    )
    expect(manual.pots.find((p: Json) => p.potId === invest)).toMatchObject({
      assignedCents: 10_000,
      assignmentSource: 'manuell',
    })
  })

  it('füllt nur so weit, wie Geld ohne Aufgabe da ist', async () => {
    const a = await setup()
    await salaryRule(a.token, a.householdId)
    const miete = await potId(a.token, a.householdId, { name: 'Miete', kind: 'monatlich' })
    await importInto(a.token, a.accountId, [salary(current, 100_000)])
    await assign(a.token, a.householdId, current, miete, 95_000)
    const invest = await potId(a.token, a.householdId, {
      name: 'Investieren',
      kind: 'erst_ich',
      amountCents: 20_000,
    })
    const view = await body(await month(a.token, a.householdId, current))
    expect(view.pots.find((p: Json) => p.potId === invest).assignedCents).toBe(5_000)
    expect(view.readyToAssignCents).toBe(0)
  })
})

describe('Monatsabschluss', () => {
  it('schließt vergangene Monate der Reihe nach ab und sperrt sie', async () => {
    const a = await setup()
    await startAt(a.token, a.householdId, beforePrevious)
    await salaryRule(a.token, a.householdId)
    const essen = await potId(a.token, a.householdId, { name: 'Essen', kind: 'monatlich' })
    await importInto(a.token, a.accountId, [salary(beforePrevious), salary(previous)])
    // Vorschläge aus der Regel bestätigen
    const pending = await body(await request('GET', '/v1/transactions/pending', undefined, a.token))
    for (const t of pending.items) {
      expect(
        (await request('POST', `/v1/transactions/${t.id}/confirm`, undefined, a.token)).status,
      ).toBe(200)
    }
    await assign(a.token, a.householdId, beforePrevious, essen, 10_000)

    const close = (m: string) =>
      request('POST', `/v1/households/${a.householdId}/budget/${m}/closing`, undefined, a.token)

    const running = await close(current)
    expect(running.status).toBe(409)
    expect((await body(running)).error.code).toBe('monat_laeuft_noch')

    const outOfOrder = await close(previous)
    expect(outOfOrder.status).toBe(409)
    expect((await body(outOfOrder)).error.code).toBe('vormonat_offen')

    const first = await close(beforePrevious)
    expect(first.status).toBe(201)
    expect((await body(first)).closedAt).not.toBeNull()
    expect((await close(beforePrevious)).status).toBe(409)

    const locked = await assign(a.token, a.householdId, beforePrevious, essen, 0)
    expect(locked.status).toBe(409)
    expect((await body(locked)).error.code).toBe('monat_abgeschlossen')

    expect((await close(previous)).status).toBe(201)

    const [snapshot] = await db`
      select snapshot from month_closings where household_id = ${a.householdId}
      order by month limit 1
    `
    expect(snapshot?.snapshot).toMatchObject({ month: beforePrevious, inflowsCents: 300_000 })

    // Nur der letzte Abschluss lässt sich zurücknehmen.
    const reopen = (m: string) =>
      request('DELETE', `/v1/households/${a.householdId}/budget/${m}/closing`, undefined, a.token)
    expect((await reopen(beforePrevious)).status).toBe(409)
    const reopened = await reopen(previous)
    expect(reopened.status).toBe(200)
    expect((await body(reopened)).closedAt).toBeNull()
  })

  it('schließt nicht ab, solange Buchungen auf Bestätigung warten', async () => {
    const a = await setup()
    await startAt(a.token, a.householdId, previous)
    await importInto(a.token, a.accountId, [
      { bookingDate: `${previous}-05`, amountCents: -1_000, purpose: 'Unklar' },
    ])
    const res = await request(
      'POST',
      `/v1/households/${a.householdId}/budget/${previous}/closing`,
      undefined,
      a.token,
    )
    expect(res.status).toBe(409)
    expect((await body(res)).error.code).toBe('offene_buchungen')
    const view = await body(await month(a.token, a.householdId, previous))
    expect(view.unconfirmedTransactions).toBe(1)
  })
})
