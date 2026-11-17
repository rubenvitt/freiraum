import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { addMonthsTo, monthOf } from '../src/budget/months.js'
import { todayUtc } from '../src/ledger/dates.js'
import { setupTestApp } from './helpers/app.js'

// Alle Namen, Beträge und IBANs sind erfunden.

const { db, request, reset, personWithSession } = setupTestApp()

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

async function pot(token: string, householdId: string, input: Json): Promise<string> {
  const res = await request('POST', `/v1/households/${householdId}/pots`, input, token)
  expect(res.status).toBe(201)
  return (await body(res)).id
}

async function rule(token: string, householdId: string, input: Json): Promise<void> {
  const res = await request('POST', `/v1/households/${householdId}/rules`, input, token)
  expect(res.status).toBe(201)
}

async function importInto(token: string, accountId: string, transactions: Json[]) {
  const res = await request('POST', `/v1/accounts/${accountId}/imports`, { transactions }, token)
  expect(res.status).toBe(201)
}

const salary = (m: string) => ({
  bookingDate: `${m}-01`,
  amountCents: 300_000,
  counterpartyName: 'Arbeitgeber Beispiel GmbH',
  counterpartyIban: EMPLOYER_IBAN,
  purpose: `Gehalt ${m}`,
})
const purchase = (date: string, amountCents: number, counterpartyName: string) => ({
  bookingDate: date,
  amountCents,
  counterpartyName,
  purpose: 'Einkauf',
})

/** Person mit Gehalt, Lebensmitteln, Kfz und einer nicht zugeordneten Ausgabe. */
async function scenario() {
  const a = await setup()
  const food = await pot(a.token, a.householdId, {
    name: 'Lebensmittel',
    kind: 'monatlich',
    groupName: 'Alltag',
  })
  const car = await pot(a.token, a.householdId, {
    name: 'Kfz',
    kind: 'ruecklage',
    amountCents: 120_000,
  })
  await rule(a.token, a.householdId, {
    counterpartyIban: EMPLOYER_IBAN,
    direction: 'eingang',
    kind: 'einnahme',
  })
  await rule(a.token, a.householdId, {
    counterpartyName: 'Supermarkt Beispiel',
    direction: 'ausgang',
    kind: 'topf',
    potId: food,
  })
  await rule(a.token, a.householdId, {
    counterpartyName: 'Werkstatt Beispiel',
    direction: 'ausgang',
    kind: 'topf',
    potId: car,
  })
  await importInto(a.token, a.accountId, [
    salary(beforePrevious),
    salary(previous),
    salary(current),
    purchase(`${beforePrevious}-10`, -40_000, 'Supermarkt Beispiel'),
    purchase(`${previous}-10`, -40_000, 'Supermarkt Beispiel'),
    purchase(`${previous}-12`, -30_000, 'Werkstatt Beispiel'),
    purchase(`${previous}-20`, -5_000, 'Unbekannt Beispiel'),
    purchase(`${current}-01`, -10_000, 'Supermarkt Beispiel'),
  ])
  return { ...a, food, car }
}

const analytics = (token: string, householdId: string, what: string, query = '') =>
  request('GET', `/v1/households/${householdId}/analytics/${what}${query}`, undefined, token)

describe('Kennzahlen', () => {
  it('liefert je Monat Einkommen, Konsum, Sparquote und Runway', async () => {
    const a = await scenario()
    const res = await analytics(a.token, a.householdId, 'metrics', `?from=${beforePrevious}`)
    expect(res.status).toBe(200)
    const m = await body(res)
    expect(m).toMatchObject({ householdId: a.householdId, from: beforePrevious, to: current })
    expect(m.months.map((x: Json) => x.month)).toEqual([beforePrevious, previous, current])
    expect(m.months[0]).toMatchObject({
      incomeCents: 300_000,
      consumptionCents: 40_000,
      savedCents: 260_000,
      savingsRateBp: 8_667,
      uncategorizedOutCents: 0,
    })
    expect(m.months[1]).toMatchObject({
      consumptionCents: 75_000,
      uncategorizedOutCents: 5_000,
      savingsRateBp: 7_500,
    })
    expect(m.months[0].ageOfMoneyDays).toBe(9)
    expect(m.totals).toMatchObject({ incomeCents: 900_000, consumptionCents: 125_000 })
    // Geld: 900 000 − 125 000; Konsum der abgeschlossenen Monate: (40 000 + 75 000) / 2
    expect(m.runway).toEqual({
      cashCents: 775_000,
      averageMonthlyConsumptionCents: 57_500,
      basedOnMonths: 2,
      months: 13.5,
    })
  })

  it('zählt im Runway nur Geld ab dem Budgetbeginn (davor steckt es im Anfangsbestand)', async () => {
    const a = await scenario()
    const res = await request(
      'PUT',
      `/v1/households/${a.householdId}/budget-start`,
      { month: current },
      a.token,
    )
    expect(res.status).toBe(200)
    const m = await body(await analytics(a.token, a.householdId, 'metrics'))
    // ohne bekannte Kontostände ist der Anfangsbestand 0: nur Gehalt und Einkauf des Monats
    expect(m.runway.cashCents).toBe(290_000)
  })

  it('nimmt standardmäßig die letzten 12 Monate und prüft den Zeitraum', async () => {
    const a = await setup()
    const m = await body(await analytics(a.token, a.householdId, 'metrics'))
    expect(m.months).toHaveLength(12)
    expect(m.to).toBe(current)
    expect(m.runway.months).toBeNull()

    const reversed = await analytics(
      a.token,
      a.householdId,
      'metrics',
      `?from=${current}&to=${previous}`,
    )
    expect(reversed.status).toBe(422)
    expect((await body(reversed)).error.code).toBe('zeitraum_ungueltig')
    const tooLong = await analytics(
      a.token,
      a.householdId,
      'metrics',
      `?from=${addMonthsTo(current, -120)}`,
    )
    expect(tooLong.status).toBe(422)
    expect((await analytics(a.token, a.householdId, 'metrics', '?from=2026-13')).status).toBe(400)
  })
})

describe('Geldfluss', () => {
  it('zeigt Einkommen, Töpfe, Unzugeordnetes und den Rest', async () => {
    const a = await scenario()
    const res = await analytics(a.token, a.householdId, 'flow', `?from=${previous}&to=${previous}`)
    expect(res.status).toBe(200)
    const f = await body(res)
    expect(f.nodes.map((n: Json) => [n.kind, n.label])).toEqual([
      ['haushalt', 'Person A'],
      ['quelle', 'Arbeitgeber Beispiel GmbH'],
      ['gruppe', 'Alltag'],
      ['topf', 'Lebensmittel'],
      ['topf', 'Kfz'],
      ['rest', 'Noch nicht zugeordnet'],
      ['rest', 'Übrig'],
    ])
    expect(f).toMatchObject({ inCents: 300_000, outCents: 75_000 })
    const food = f.nodes.find((n: Json) => n.label === 'Lebensmittel')
    expect(food).toMatchObject({ potId: a.food, potKind: 'monatlich' })
    expect(f.links).toContainEqual({
      source: 'haushalt',
      target: 'rest:uebrig',
      valueCents: 225_000,
    })
  })
})

describe('Ziele', () => {
  it('prognostiziert aus der Sparrate, wann ein Ziel erreicht ist', async () => {
    const a = await scenario()
    const bike = await pot(a.token, a.householdId, {
      name: 'Fahrrad',
      kind: 'ziel',
      amountCents: 120_000,
      targetMonth: addMonthsTo(current, 5),
    })
    const res = await request(
      'PUT',
      `/v1/households/${a.householdId}/budget/${current}/pots/${bike}`,
      { assignedCents: 30_000 },
      a.token,
    )
    expect(res.status).toBe(200)
    const g = await body(await analytics(a.token, a.householdId, 'goals'))
    expect(g.month).toBe(current)
    expect(g.items).toEqual([
      {
        potId: bike,
        name: 'Fahrrad',
        targetCents: 120_000,
        savedCents: 30_000,
        remainingCents: 90_000,
        progressBp: 2_500,
        targetMonth: addMonthsTo(current, 5),
        monthlyRateCents: 10_000,
        projectedMonth: addMonthsTo(current, 9),
        requiredMonthlyCents: 18_000,
        status: 'verspaetet',
      },
    ])
  })
})

describe('Auffälligkeiten', () => {
  it('liefert die Liste des Monats', async () => {
    const a = await scenario()
    const res = await analytics(a.token, a.householdId, 'anomalies', `?month=${previous}`)
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ householdId: a.householdId, month: previous, items: [] })
  })
})

describe('Besitz und Besitzkosten', () => {
  it('verknüpft Töpfe und rechnet die Kosten im Verhältnis zum Wert', async () => {
    const a = await scenario()
    const created = await request(
      'POST',
      `/v1/households/${a.householdId}/assets`,
      { name: 'Auto', valueCents: 1_500_000, potIds: [a.car] },
      a.token,
    )
    expect(created.status).toBe(201)
    const asset = await body(created)
    expect(asset).toMatchObject({ name: 'Auto', valueCents: 1_500_000, potIds: [a.car] })

    const costs = await body(await analytics(a.token, a.householdId, 'ownership-costs'))
    expect(costs.items).toEqual([
      {
        assetId: asset.id,
        name: 'Auto',
        valueCents: 1_500_000,
        costCents: 30_000,
        recurringCostCents: 0,
        monthlyAverageCents: 2_500,
        annualCostOfValueBp: 200,
        classification: 'verbindlichkeit',
        pots: [{ potId: a.car, name: 'Kfz', costCents: 30_000 }],
      },
    ])
    expect(costs).toMatchObject({ totalCostCents: 30_000, shareOfConsumptionBp: 2_400 })

    // Name doppelt, Topf schon vergeben
    const dup = await request(
      'POST',
      `/v1/households/${a.householdId}/assets`,
      { name: 'auto' },
      a.token,
    )
    expect(dup.status).toBe(409)
    expect((await body(dup)).error.code).toBe('besitz_name_vergeben')
    const taken = await request(
      'POST',
      `/v1/households/${a.householdId}/assets`,
      { name: 'Wohnwagen', potIds: [a.car] },
      a.token,
    )
    expect(taken.status).toBe(409)
    expect((await body(taken)).error.code).toBe('topf_schon_verknuepft')

    // Ändern, archivieren, löschen
    const patched = await request(
      'PATCH',
      `/v1/assets/${asset.id}`,
      { valueCents: null, potIds: [a.car, a.food] },
      a.token,
    )
    expect(await body(patched)).toMatchObject({ valueCents: null, potIds: [a.food, a.car] })
    await request('PATCH', `/v1/assets/${asset.id}`, { archived: true }, a.token)
    const list = await body(
      await request('GET', `/v1/households/${a.householdId}/assets`, undefined, a.token),
    )
    expect(list.items).toEqual([])
    expect((await body(await analytics(a.token, a.householdId, 'ownership-costs'))).items).toEqual(
      [],
    )
    expect((await request('DELETE', `/v1/assets/${asset.id}`, undefined, a.token)).status).toBe(204)
    expect((await request('DELETE', `/v1/assets/${asset.id}`, undefined, a.token)).status).toBe(404)
  })
})

describe('Privatsphäre', () => {
  it('zeigt fremde Haushalte, Besitz und Töpfe nicht (404 bzw. 422)', async () => {
    const a = await scenario()
    const b = await setup('Person B')
    const asset = await body(
      await request(
        'POST',
        `/v1/households/${a.householdId}/assets`,
        { name: 'Auto', potIds: [a.car] },
        a.token,
      ),
    )
    for (const what of ['metrics', 'flow', 'anomalies', 'goals', 'ownership-costs']) {
      const res = await analytics(b.token, a.householdId, what)
      expect(res.status, what).toBe(404)
      expect((await body(res)).error.code).toBe('haushalt_nicht_gefunden')
    }
    expect(
      (await request('GET', `/v1/households/${a.householdId}/assets`, undefined, b.token)).status,
    ).toBe(404)
    expect(
      (await request('PATCH', `/v1/assets/${asset.id}`, { name: 'Meins' }, b.token)).status,
    ).toBe(404)
    expect((await request('DELETE', `/v1/assets/${asset.id}`, undefined, b.token)).status).toBe(404)
    // A's Topf lässt sich nicht an B's Besitz hängen
    const foreign = await request(
      'POST',
      `/v1/households/${b.householdId}/assets`,
      { name: 'Fahrrad', potIds: [a.food] },
      b.token,
    )
    expect(foreign.status).toBe(422)
    expect((await body(foreign)).error.code).toBe('topf_fremd')
    // ohne Anmeldung
    expect((await analytics('', a.householdId, 'metrics')).status).toBe(401)
  })
})
