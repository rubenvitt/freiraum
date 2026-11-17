import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { computeMonth } from '../src/budget/compute.js'
import { addMonthsTo, monthOf } from '../src/budget/months.js'
import { openClaims } from '../src/couple/settle.js'
import { todayUtc } from '../src/ledger/dates.js'
import { setupTestApp } from './helpers/app.js'

// Alle Namen, Beträge und IBANs sind erfunden.

const { db, ledger, request, reset, personWithSession } = setupTestApp()

afterAll(() => db.end())
beforeEach(() => reset())

type Json = Record<string, any>
const body = async (res: Response): Promise<Json> => (await res.json()) as Json

const current = monthOf(todayUtc())
const next = addMonthsTo(current, 1)
const day = (d: number) => `${current}-${String(d).padStart(2, '0')}`

const IBAN_A = 'DE11100000000000000001'
const IBAN_B = 'DE22100000000000000002'
const IBAN_SHARED = 'DE33100000000000000003'
const IBAN_EMPLOYER = 'DE44100000000000000004'

async function person(name: string, iban: string | null) {
  const p = await personWithSession(name)
  const { items } = await body(await request('GET', '/v1/households', undefined, p.token))
  const householdId = items.find((h: Json) => h.kind === 'privat').id as string
  const account = await body(
    await request(
      'POST',
      '/v1/accounts',
      { householdId, name: `Giro ${name}`, source: 'bank', ...(iban ? { iban } : {}) },
      p.token,
    ),
  )
  return { ...p, id: p.person.id, householdId, accountId: account.id as string }
}

/** Zwei Personen mit privaten Konten und ein gemeinsamer Haushalt mit Konto. */
async function couple(options: { ibanB?: string | null } = {}) {
  const a = await person('Person A', IBAN_A)
  const b = await person('Person B', options.ibanB === undefined ? IBAN_B : options.ibanB)
  const shared = await ledger.createSharedHousehold('Gemeinsam', [a.id, b.id])
  const account = await body(
    await request(
      'POST',
      '/v1/accounts',
      { householdId: shared.id, name: 'Gemeinschaftskonto', source: 'bank', iban: IBAN_SHARED },
      a.token,
    ),
  )
  return { a, b, sharedId: shared.id, sharedAccountId: account.id as string }
}

const importInto = async (token: string, accountId: string, transactions: Json[]) => {
  const res = await request('POST', `/v1/accounts/${accountId}/imports`, { transactions }, token)
  expect(res.status).toBe(201)
  return body(res)
}

const transactions = async (token: string, accountId: string) =>
  (await body(await request('GET', `/v1/accounts/${accountId}/transactions`, undefined, token)))
    .items as any[] as [Json, Json, ...Json[]]

const budget = async (token: string, householdId: string, m = current) =>
  body(await request('GET', `/v1/households/${householdId}/budget/${m}`, undefined, token))

async function pot(token: string, householdId: string, input: Json): Promise<string> {
  const res = await request('POST', `/v1/households/${householdId}/pots`, input, token)
  expect(res.status).toBe(201)
  return (await body(res)).id
}

const setSplits = (token: string, transactionId: string, splits: Json[], learn = true) =>
  request('PUT', `/v1/transactions/${transactionId}/splits`, { splits, learn }, token)

/** Gehalt aufs private Konto, per Regel als Einnahme erkannt. */
async function salary(p: { token: string; householdId: string; accountId: string }, cents: number) {
  await request(
    'POST',
    `/v1/households/${p.householdId}/rules`,
    { counterpartyIban: IBAN_EMPLOYER, direction: 'eingang', kind: 'einnahme' },
    p.token,
  )
  await importInto(p.token, p.accountId, [
    {
      bookingDate: day(1),
      amountCents: cents,
      counterpartyName: 'Arbeitgeber Beispiel GmbH',
      counterpartyIban: IBAN_EMPLOYER,
      purpose: `Gehalt ${current}`,
    },
  ])
}

const settlements = async (token: string, householdId: string) =>
  body(await request('GET', `/v1/households/${householdId}/settlements`, undefined, token))

describe('Rechnung (rein)', () => {
  it('mindert „Noch ohne Aufgabe“ um Einzahlungen, aber nicht den Erst-ich-Anteil', () => {
    const data = {
      pots: [
        {
          id: 'p',
          kind: 'erst_ich' as const,
          amountCents: null,
          percentBp: 1_000,
          targetMonth: null,
        },
      ],
      assignments: [],
      activity: [],
      inflows: [{ month: '2026-11', amountCents: 300_000 }],
      contributions: [{ month: '2026-11', amountCents: -120_000 }],
    }
    const m = computeMonth(data, '2026-11')
    expect(m.inflowsCents).toBe(300_000)
    expect(m.contributionsCents).toBe(-120_000)
    expect(m.readyToAssignCents).toBe(180_000)
    expect(m.pots[0]?.planCents).toBe(30_000)
    // Der Folgemonat erbt die Wirkung.
    expect(computeMonth(data, '2026-12').readyToAssignCents).toBe(180_000)
  })

  it('deckt offene Ausgaben der Reihe nach, älteste zuerst', () => {
    const claims = [
      { id: 'alt', amountCents: 3_000 },
      { id: 'gutschrift', amountCents: -500 },
      { id: 'neu', amountCents: 2_000 },
    ]
    expect(openClaims(claims, 0)).toEqual(
      new Map([
        ['alt', 2_500],
        ['neu', 2_000],
      ]),
    )
    expect(openClaims(claims, 3_000)).toEqual(new Map([['neu', 1_500]]))
    expect(openClaims(claims, 10_000)).toEqual(new Map())
  })
})

describe('Einzahlungen ins Gemeinsame', () => {
  it('erkennt Überweisungen zwischen eigenen Konten und rechnet sie in beide Budgets', async () => {
    const { a, sharedId, sharedAccountId } = await couple()
    await salary(a, 300_000)
    await pot(a.token, a.householdId, { name: 'Investieren', kind: 'erst_ich', percentBp: 1_000 })

    await importInto(a.token, a.accountId, [
      {
        bookingDate: day(2),
        amountCents: -100_000,
        counterpartyName: 'Gemeinschaftskonto',
        counterpartyIban: IBAN_SHARED,
        purpose: 'Haushaltsgeld',
      },
    ])
    const [outgoing] = (await transactions(a.token, a.accountId)).filter((t) => t.amountCents < 0)
    expect(outgoing).toMatchObject({
      status: 'vorgeschlagen',
      splits: [{ kind: 'einzahlung', potId: null, personId: null, amountCents: -100_000 }],
      suggestion: { source: 'abgleich', kind: 'einzahlung', confidencePct: 100 },
    })

    const own = await budget(a.token, a.householdId)
    expect(own.inflowsCents).toBe(300_000)
    expect(own.contributionsCents).toBe(-100_000)
    // Erst ich bekommt 10 % der vollen Einnahmen, die Einzahlung mindert nur den Rest.
    expect(own.pots[0]).toMatchObject({ name: 'Investieren', assignedCents: 30_000 })
    expect(own.readyToAssignCents).toBe(300_000 - 100_000 - 30_000)

    await importInto(a.token, sharedAccountId, [
      {
        bookingDate: day(2),
        amountCents: 100_000,
        counterpartyName: 'Person A',
        counterpartyIban: IBAN_A,
        purpose: 'Haushaltsgeld',
      },
    ])
    const [incoming] = await transactions(a.token, sharedAccountId)
    expect(incoming).toMatchObject({
      status: 'vorgeschlagen',
      splits: [{ kind: 'einzahlung', personId: a.id, amountCents: 100_000 }],
      suggestion: {
        source: 'abgleich',
        personId: a.id,
        reason: 'Abgleich: Einzahlung von Person A',
      },
    })
    // Die Begründung nennt nie das private Konto.
    expect(JSON.stringify(incoming)).not.toContain('Giro Person A')

    const shared = await budget(a.token, sharedId)
    expect(shared).toMatchObject({
      inflowsCents: 100_000,
      contributionsCents: 0,
      readyToAssignCents: 100_000,
    })
  })

  it('lernt Einzahlungen von einer Person ohne eigenes Konto in Freiraum', async () => {
    const { a, b, sharedAccountId } = await couple({ ibanB: null })
    const transfer = (m: string) => ({
      bookingDate: `${m}-03`,
      amountCents: 80_000,
      counterpartyName: 'Person B',
      counterpartyIban: IBAN_B,
      purpose: 'Dauerauftrag',
    })
    await importInto(a.token, sharedAccountId, [transfer(current)])
    const [t] = await transactions(a.token, sharedAccountId)
    expect(t.status).toBe('importiert')

    // Ohne Person geht es nicht, mit einer fremden auch nicht.
    const noPerson = await setSplits(a.token, t.id, [{ kind: 'einzahlung', amountCents: 80_000 }])
    expect(noPerson.status).toBe(422)
    expect((await body(noPerson)).error.code).toBe('person_fehlt')
    const outsider = await personWithSession('Person C')
    const foreign = await setSplits(a.token, t.id, [
      { kind: 'einzahlung', personId: outsider.person.id, amountCents: 80_000 },
    ])
    expect((await body(foreign)).error.code).toBe('person_ungueltig')

    const res = await setSplits(a.token, t.id, [
      { kind: 'einzahlung', personId: b.id, amountCents: 80_000 },
    ])
    expect(res.status).toBe(200)
    expect((await body(res)).rule).toMatchObject({
      kind: 'einzahlung',
      personId: b.id,
      direction: 'eingang',
      counterpartyIban: IBAN_B,
    })

    await importInto(a.token, sharedAccountId, [transfer(next)])
    const later = (await transactions(a.token, sharedAccountId)).find(
      (x) => x.bookingDate === `${next}-03`,
    )
    expect(later).toMatchObject({
      status: 'vorgeschlagen',
      splits: [{ kind: 'einzahlung', personId: b.id }],
      suggestion: { source: 'regel', personId: b.id },
    })
  })

  it('prüft Richtung und Haushalt von Einzahlung und Ausgleich', async () => {
    const { a, sharedAccountId } = await couple()
    const loner = await person('Person C', null)
    await importInto(a.token, a.accountId, [
      { bookingDate: day(4), amountCents: 2_000, counterpartyName: 'Unbekannt' },
    ])
    await importInto(loner.token, loner.accountId, [
      { bookingDate: day(4), amountCents: -2_000, counterpartyName: 'Unbekannt' },
    ])
    await importInto(a.token, sharedAccountId, [
      { bookingDate: day(4), amountCents: -2_000, counterpartyName: 'Unbekannt' },
    ])
    const [incoming] = await transactions(a.token, a.accountId)
    const [lonely] = await transactions(loner.token, loner.accountId)
    const [sharedOut] = await transactions(a.token, sharedAccountId)

    const wrongWay = await setSplits(a.token, incoming.id, [
      { kind: 'einzahlung', amountCents: 2_000 },
    ])
    expect(wrongWay.status).toBe(422)
    expect((await body(wrongWay)).error.code).toBe('richtung_unpassend')

    const noShared = await setSplits(loner.token, lonely.id, [
      { kind: 'einzahlung', amountCents: -2_000 },
    ])
    expect((await body(noShared)).error.code).toBe('kein_gemeinsamer_haushalt')

    const personOnTopf = await setSplits(a.token, incoming.id, [
      { kind: 'einnahme', personId: a.id, amountCents: 2_000 },
    ])
    expect((await body(personOnTopf)).error.code).toBe('ziel_ungueltig')

    const sharedIn = await setSplits(a.token, sharedOut.id, [
      { kind: 'einzahlung', personId: a.id, amountCents: -2_000 },
    ])
    expect((await body(sharedIn)).error.code).toBe('richtung_unpassend')

    // Regeln bekommen die feste Richtung als Merkmal.
    const rule = await request(
      'POST',
      `/v1/households/${a.householdId}/rules`,
      { counterpartyName: 'Unbekannt', kind: 'ausgleich' },
      a.token,
    )
    expect(rule.status).toBe(201)
    expect((await body(rule)).rule).toMatchObject({ kind: 'ausgleich', direction: 'eingang' })
    const conflicting = await request(
      'POST',
      `/v1/households/${a.householdId}/rules`,
      { counterpartyName: 'Andere', direction: 'eingang', kind: 'einzahlung' },
      a.token,
    )
    expect((await body(conflicting)).error.code).toBe('richtung_unpassend')
  })
})

describe('Einzahlungsregeln', () => {
  it('rechnet Soll und Ist je Person und zeigt ein Soll vom Netto nur mit Freigabe', async () => {
    const { a, b, sharedId, sharedAccountId } = await couple()
    await salary(a, 300_000)
    const put = (token: string, m: string, rule: Json) =>
      request('PUT', `/v1/households/${sharedId}/contribution-rules/${m}`, rule, token)
    expect((await put(a.token, current, { kind: 'prozent', percentBp: 4_000 })).status).toBe(200)
    expect((await put(b.token, current, { kind: 'fest', amountCents: 80_000 })).status).toBe(200)
    // Ab dem nächsten Monat fest; der laufende Monat bleibt beim Anteil.
    expect((await put(a.token, next, { kind: 'fest', amountCents: 110_000 })).status).toBe(200)

    await importInto(a.token, sharedAccountId, [
      { bookingDate: day(2), amountCents: 100_000, counterpartyIban: IBAN_A, purpose: 'Anteil' },
    ])
    const view = (token: string, m = current) =>
      request('GET', `/v1/households/${sharedId}/contributions/${m}`, undefined, token)

    const forA = await body(await view(a.token))
    expect(forA.members).toEqual([
      expect.objectContaining({
        personId: a.id,
        rule: expect.objectContaining({ kind: 'prozent', percentBp: 4_000, validFrom: current }),
        targetCents: 120_000,
        targetVisible: true,
        paidCents: 100_000,
        remainingCents: 20_000,
      }),
      expect.objectContaining({
        personId: b.id,
        targetCents: 80_000,
        targetVisible: true,
        paidCents: 0,
        remainingCents: 80_000,
      }),
    ])

    // B sieht das Soll von A nicht: Es verriete das Einkommen.
    const forB = await body(await view(b.token))
    expect(forB.members[0]).toMatchObject({
      personId: a.id,
      targetCents: null,
      targetVisible: false,
      paidCents: 100_000,
      remainingCents: null,
    })
    await request('PUT', `/v1/shares/${b.id}/einzahlung_soll`, undefined, a.token)
    expect((await body(await view(b.token))).members[0]).toMatchObject({ targetCents: 120_000 })
    await request('DELETE', `/v1/shares/${b.id}/einzahlung_soll`, undefined, a.token)
    expect((await body(await view(b.token))).members[0].targetCents).toBeNull()

    expect((await body(await view(a.token, next))).members[0]).toMatchObject({
      rule: expect.objectContaining({ kind: 'fest', validFrom: next }),
      targetCents: 110_000,
    })
    const rules = await body(
      await request('GET', `/v1/households/${sharedId}/contribution-rules`, undefined, b.token),
    )
    expect(rules.items).toHaveLength(3)

    // Löschen gibt der vorigen Regel wieder Geltung; fremde Regeln gibt es für B nicht.
    expect(
      (
        await request(
          'DELETE',
          `/v1/households/${sharedId}/contribution-rules/${next}`,
          undefined,
          b.token,
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await request(
          'DELETE',
          `/v1/households/${sharedId}/contribution-rules/${next}`,
          undefined,
          a.token,
        )
      ).status,
    ).toBe(204)
    expect((await body(await view(a.token, next))).members[0].rule.kind).toBe('prozent')
  })

  it('prüft Regel, Haushaltsart und Zugriff', async () => {
    const { a, sharedId } = await couple()
    const outsider = await person('Person C', null)
    const put = (token: string, householdId: string, rule: Json) =>
      request('PUT', `/v1/households/${householdId}/contribution-rules/${current}`, rule, token)
    for (const rule of [
      { kind: 'fest' },
      { kind: 'prozent' },
      { kind: 'fest', amountCents: 1, percentBp: 1 },
    ]) {
      const res = await put(a.token, sharedId, rule)
      expect(res.status).toBe(422)
      expect((await body(res)).error.code).toBe('einzahlungsregel_ungueltig')
    }
    const privateHousehold = await put(a.token, a.householdId, { kind: 'fest', amountCents: 1 })
    expect((await body(privateHousehold)).error.code).toBe('nicht_gemeinsam')
    expect((await put(outsider.token, sharedId, { kind: 'fest', amountCents: 1 })).status).toBe(404)
    expect(
      (
        await request(
          'GET',
          `/v1/households/${sharedId}/contributions/${current}`,
          undefined,
          outsider.token,
        )
      ).status,
    ).toBe(404)
  })
})

describe('Ausgleich', () => {
  it('führt privat bezahlte gemeinsame Ausgaben bis zur Erstattung', async () => {
    const { a, b, sharedId, sharedAccountId } = await couple()
    await salary(a, 300_000)
    const groceries = await pot(a.token, sharedId, { name: 'Lebensmittel', kind: 'monatlich' })
    const fun = await pot(a.token, a.householdId, { name: 'Freizeit', kind: 'monatlich' })
    const before = await budget(a.token, a.householdId)

    await importInto(a.token, a.accountId, [
      {
        bookingDate: day(5),
        amountCents: -6_000,
        counterpartyName: 'Supermarkt Beispiel',
        purpose: 'Einkauf mit Kundenkarte 123',
      },
      { bookingDate: day(6), amountCents: -10_000, counterpartyName: 'Markt Beispiel' },
    ])
    const [mixed, single] = await transactions(a.token, a.accountId)
    expect(
      (
        await setSplits(a.token, single.id, [
          { kind: 'topf', potId: groceries, amountCents: -6_000 },
        ])
      ).status,
    ).toBe(200)
    expect(
      (
        await setSplits(
          a.token,
          mixed.id,
          [
            { kind: 'topf', potId: groceries, amountCents: -4_000 },
            { kind: 'topf', potId: fun, amountCents: -6_000 },
          ],
          false,
        )
      ).status,
    ).toBe(200)

    // Gemeinsamer Topf trägt die Ausgabe; das private Budget bleibt bis auf den eigenen Anteil gleich.
    const sharedBudget = await budget(a.token, sharedId)
    expect(sharedBudget.pots.find((p: Json) => p.potId === groceries).activityCents).toBe(-10_000)
    const own = await budget(a.token, a.householdId)
    expect(own.readyToAssignCents).toBe(before.readyToAssignCents)
    expect(own.pots.find((p: Json) => p.potId === fun).activityCents).toBe(-6_000)

    const forB = await settlements(b.token, sharedId)
    expect(forB.balances).toEqual([
      expect.objectContaining({ personId: a.id, claimedCents: 10_000, openCents: 10_000 }),
      expect.objectContaining({ personId: b.id, claimedCents: 0, openCents: 0 }),
    ])
    expect(forB.openItems).toEqual([
      {
        transactionId: mixed.id,
        personId: a.id,
        bookingDate: day(6),
        counterpartyName: 'Markt Beispiel',
        amountCents: 4_000,
        openCents: 4_000,
      },
      {
        transactionId: single.id,
        personId: a.id,
        bookingDate: day(5),
        counterpartyName: 'Supermarkt Beispiel',
        amountCents: 6_000,
        openCents: 6_000,
      },
    ])
    // Verwendungszweck und Konto bleiben privat.
    expect(JSON.stringify(forB)).not.toContain('Kundenkarte')
    expect(JSON.stringify(forB)).not.toContain(a.accountId)

    // Erstattung vom gemeinsamen Konto wird erkannt und deckt die älteste Ausgabe.
    await importInto(b.token, sharedAccountId, [
      { bookingDate: day(7), amountCents: -6_000, counterpartyIban: IBAN_A, purpose: 'Ausgleich' },
    ])
    const [refund] = await transactions(b.token, sharedAccountId)
    expect(refund.splits).toEqual([
      { kind: 'ausgleich', potId: null, personId: a.id, amountCents: -6_000 },
    ])
    const afterRefund = await settlements(a.token, sharedId)
    expect(afterRefund.balances[0]).toMatchObject({ repaidCents: 6_000, openCents: 4_000 })
    expect(afterRefund.openItems.map((i: Json) => i.transactionId)).toEqual([mixed.id])
    // Die Erstattung belastet das gemeinsame Budget nicht ein zweites Mal.
    const afterRefundBudget = await budget(a.token, sharedId)
    expect(afterRefundBudget.readyToAssignCents).toBe(sharedBudget.readyToAssignCents)
    expect(afterRefundBudget.pots.find((p: Json) => p.potId === groceries).activityCents).toBe(
      -10_000,
    )

    // Auf dem privaten Konto ist die Gutschrift ein Ausgleich, keine Einnahme.
    await importInto(a.token, a.accountId, [
      { bookingDate: day(7), amountCents: 6_000, counterpartyIban: IBAN_SHARED },
    ])
    const credit = (await transactions(a.token, a.accountId)).find((t) => t.amountCents === 6_000)
    expect(credit?.splits).toEqual([
      { kind: 'ausgleich', potId: null, personId: null, amountCents: 6_000 },
    ])
    expect((await budget(a.token, a.householdId)).inflowsCents).toBe(300_000)

    // Von Hand: nur die eigene Forderung, höchstens der offene Rest.
    const tooMuch = await request(
      'POST',
      `/v1/households/${sharedId}/settlements`,
      { amountCents: 4_001 },
      a.token,
    )
    expect((await body(tooMuch)).error.code).toBe('ausgleich_zu_hoch')
    const notB = await request(
      'POST',
      `/v1/households/${sharedId}/settlements`,
      { amountCents: 1 },
      b.token,
    )
    expect(notB.status).toBe(422)
    const manual = await request(
      'POST',
      `/v1/households/${sharedId}/settlements`,
      { amountCents: 4_000, note: 'bar' },
      a.token,
    )
    expect(manual.status).toBe(201)
    const settled = await body(manual)
    expect(settled.balances[0]).toMatchObject({ repaidCents: 10_000, openCents: 0 })
    expect(settled.openItems).toEqual([])
    const manualId = settled.manual[0].id as string
    expect(
      (await request('DELETE', `/v1/settlements/${manualId}`, undefined, b.token)).status,
    ).toBe(403)
    expect(
      (await request('DELETE', `/v1/settlements/${manualId}`, undefined, a.token)).status,
    ).toBe(204)
    expect((await settlements(a.token, sharedId)).balances[0].openCents).toBe(4_000)
  })

  it('erlaubt gemeinsame Töpfe nur von privaten Konten der Mitglieder', async () => {
    const { a, sharedId, sharedAccountId } = await couple()
    const outsider = await person('Person C', null)
    const groceries = await pot(a.token, sharedId, { name: 'Lebensmittel', kind: 'monatlich' })
    const privatePot = await pot(a.token, a.householdId, { name: 'Freizeit', kind: 'monatlich' })
    const spend = { bookingDate: day(5), amountCents: -1_000, counterpartyName: 'Laden' }
    await importInto(outsider.token, outsider.accountId, [spend])
    await importInto(a.token, sharedAccountId, [spend])
    const [foreign] = await transactions(outsider.token, outsider.accountId)
    const [sharedSpend] = await transactions(a.token, sharedAccountId)

    const res = await setSplits(outsider.token, foreign.id, [
      { kind: 'topf', potId: groceries, amountCents: -1_000 },
    ])
    expect((await body(res)).error.code).toBe('topf_anderer_haushalt')
    const back = await setSplits(a.token, sharedSpend.id, [
      { kind: 'topf', potId: privatePot, amountCents: -1_000 },
    ])
    expect((await body(back)).error.code).toBe('topf_anderer_haushalt')

    // Auch an der Oberfläche vorbei hält die Datenbank stand.
    await expect(
      db.begin(async (tx) => {
        await tx`
          insert into transaction_splits (transaction_id, kind, pot_id, amount_cents)
          values (${foreign.id}, 'topf', ${groceries}, -1000)
        `
      }),
    ).rejects.toThrow(/Topf gehört nicht zum Haushalt/)
    await expect(
      db.begin(async (tx) => {
        await tx`
          insert into transaction_splits (transaction_id, kind, person_id, amount_cents)
          values (${sharedSpend.id}, 'einzahlung', ${outsider.person.id}, -1000)
        `
      }),
    ).rejects.toThrow(/Einzahlung oder Ausgleich/)

    expect(
      (await request('GET', `/v1/households/${sharedId}/settlements`, undefined, outsider.token))
        .status,
    ).toBe(404)
    expect(
      (await request('GET', `/v1/households/${a.householdId}/settlements`, undefined, a.token))
        .status,
    ).toBe(422)
  })
})

describe('Freigaben und Kennzahlen', () => {
  it('zeigt Kennzahlen der anderen Person nur mit Freigabe, als Anteil statt Betrag', async () => {
    const { a, b } = await couple()
    await salary(a, 300_000)
    await pot(a.token, a.householdId, { name: 'Investieren', kind: 'erst_ich', percentBp: 1_000 })
    await pot(a.token, a.householdId, {
      name: 'Versicherung',
      kind: 'ruecklage',
      amountCents: 120_000,
    })
    const metrics = (token: string, personId: string) =>
      request('GET', `/v1/persons/${personId}/metrics/${current}`, undefined, token)

    expect(await body(await metrics(a.token, a.id))).toEqual({
      personId: a.id,
      month: current,
      scopes: ['erst_ich', 'ruecklagen', 'einzahlung_soll', 'budget', 'sparquote'],
      erstIch: { hasPots: true, fulfilled: true, fundedPct: 100 },
      ruecklagen: { hasPots: true, fulfilled: false, fundedPct: 0 },
      sparquote: { savingsRatePct: 100 },
    })
    expect(await body(await metrics(b.token, a.id))).toMatchObject({
      scopes: [],
      erstIch: null,
      ruecklagen: null,
      sparquote: null,
    })

    const grant = await request('PUT', `/v1/shares/${b.id}/erst_ich`, undefined, a.token)
    expect(grant.status).toBe(200)
    expect(await body(grant)).toMatchObject({
      personId: b.id,
      displayName: 'Person B',
      scope: 'erst_ich',
    })
    // Wiederholen ändert nichts.
    expect((await request('PUT', `/v1/shares/${b.id}/erst_ich`, undefined, a.token)).status).toBe(
      200,
    )
    const shared = await body(await metrics(b.token, a.id))
    expect(shared).toMatchObject({
      scopes: ['erst_ich'],
      erstIch: { hasPots: true, fulfilled: true, fundedPct: 100 },
      ruecklagen: null,
      sparquote: null,
    })
    expect(JSON.stringify(shared)).not.toMatch(/Cents/)

    const listA = await body(await request('GET', '/v1/shares', undefined, a.token))
    expect(listA.granted).toEqual([expect.objectContaining({ personId: b.id, scope: 'erst_ich' })])
    const listB = await body(await request('GET', '/v1/shares', undefined, b.token))
    expect(listB.received).toEqual([
      expect.objectContaining({ personId: a.id, scope: 'erst_ich', householdId: a.householdId }),
    ])

    expect(
      (await request('DELETE', `/v1/shares/${b.id}/erst_ich`, undefined, a.token)).status,
    ).toBe(204)
    expect((await body(await metrics(b.token, a.id))).erstIch).toBeNull()
  })

  it('zeigt die Sparquote nur mit Freigabe, als Prozentwert ohne Beträge', async () => {
    const { a, b } = await couple()
    await salary(a, 300_000)
    const food = await pot(a.token, a.householdId, { name: 'Lebensmittel', kind: 'monatlich' })
    await importInto(a.token, a.accountId, [
      {
        bookingDate: day(2),
        amountCents: -100_000,
        counterpartyName: 'Gemeinschaftskonto',
        counterpartyIban: IBAN_SHARED,
        purpose: 'Haushaltsgeld',
      },
      { bookingDate: day(3), amountCents: -50_000, counterpartyName: 'Supermarkt Beispiel' },
    ])
    const shopping = (await transactions(a.token, a.accountId)).find(
      (t) => t.amountCents === -50_000,
    )!
    await setSplits(a.token, shopping.id, [{ kind: 'topf', potId: food, amountCents: -50_000 }])
    const metrics = (token: string, m = current) =>
      request('GET', `/v1/persons/${a.id}/metrics/${m}`, undefined, token)

    // (300 000 − 100 000 Einzahlung − 50 000 Konsum) ÷ 300 000
    expect((await body(await metrics(a.token))).sparquote).toEqual({ savingsRatePct: 50 })
    // Ohne Einkommen gibt es keine Quote.
    expect((await body(await metrics(a.token, next))).sparquote).toEqual({ savingsRatePct: null })

    expect((await body(await metrics(b.token))).sparquote).toBeNull()
    await request('PUT', `/v1/shares/${b.id}/erst_ich`, undefined, a.token)
    expect((await body(await metrics(b.token))).sparquote).toBeNull()

    expect((await request('PUT', `/v1/shares/${b.id}/sparquote`, undefined, a.token)).status).toBe(
      200,
    )
    const shared = await body(await metrics(b.token))
    expect(shared).toMatchObject({
      scopes: ['erst_ich', 'sparquote'],
      sparquote: { savingsRatePct: 50 },
    })
    expect(JSON.stringify(shared)).not.toMatch(/Cents/)

    expect(
      (await request('DELETE', `/v1/shares/${b.id}/sparquote`, undefined, a.token)).status,
    ).toBe(204)
    expect((await body(await metrics(b.token))).sparquote).toBeNull()
  })

  it('gibt nur an die Person mit gemeinsamem Haushalt frei', async () => {
    const { a } = await couple()
    const outsider = await person('Person C', null)
    expect(
      (await request('PUT', `/v1/shares/${outsider.id}/budget`, undefined, a.token)).status,
    ).toBe(404)
    expect((await request('PUT', `/v1/shares/${a.id}/budget`, undefined, a.token)).status).toBe(404)
    expect(
      (await request('GET', `/v1/persons/${a.id}/metrics/${current}`, undefined, outsider.token))
        .status,
    ).toBe(404)
    expect(
      (await request('PUT', `/v1/shares/${outsider.id}/alles`, undefined, a.token)).status,
    ).toBe(400)
  })

  it('öffnet mit der Sicht „budget“ nur das Lesen, nichts sonst', async () => {
    const { a, b } = await couple()
    await salary(a, 300_000)
    const fun = await pot(a.token, a.householdId, { name: 'Freizeit', kind: 'monatlich' })
    const read = () =>
      request('GET', `/v1/households/${a.householdId}/budget/${current}`, undefined, b.token)
    expect((await read()).status).toBe(404)

    await request('PUT', `/v1/shares/${b.id}/budget`, undefined, a.token)
    const res = await read()
    expect(res.status).toBe(200)
    expect((await body(res)).readyToAssignCents).toBe(300_000)
    expect(
      (await request('GET', `/v1/households/${a.householdId}/pots`, undefined, b.token)).status,
    ).toBe(200)
    // Schreiben, Buchungen, Regeln und Konten bleiben verborgen.
    expect(
      (
        await request(
          'PUT',
          `/v1/households/${a.householdId}/budget/${current}/pots/${fun}`,
          { assignedCents: 1 },
          b.token,
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await request(
          'POST',
          `/v1/households/${a.householdId}/pots`,
          { name: 'X', kind: 'monatlich' },
          b.token,
        )
      ).status,
    ).toBe(404)
    expect(
      (await request('GET', `/v1/accounts/${a.accountId}/transactions`, undefined, b.token)).status,
    ).toBe(404)
    expect(
      (await request('GET', `/v1/households/${a.householdId}/rules`, undefined, b.token)).status,
    ).toBe(404)
    const accounts = await body(await request('GET', '/v1/accounts', undefined, b.token))
    expect(accounts.items.map((x: Json) => x.id)).not.toContain(a.accountId)

    await request('DELETE', `/v1/shares/${b.id}/budget`, undefined, a.token)
    expect((await read()).status).toBe(404)
  })
})
