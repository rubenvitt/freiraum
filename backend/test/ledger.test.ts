import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { setupTestApp } from './helpers/app.js'

// Alle Namen, Beträge und IBANs sind erfunden.

const { db, ledger, request, reset, personWithSession } = setupTestApp()

afterAll(() => db.end())
beforeEach(() => reset())

type Json = Record<string, any>
const body = async (res: Response): Promise<Json> => (await res.json()) as Json

async function privateHousehold(token: string): Promise<string> {
  const { items } = await body(await request('GET', '/v1/households', undefined, token))
  return items.find((h: Json) => h.kind === 'privat').id
}

async function bankAccount(token: string, householdId?: string) {
  const res = await request(
    'POST',
    '/v1/accounts',
    {
      householdId: householdId ?? (await privateHousehold(token)),
      name: 'Girokonto',
      source: 'bank',
      iban: 'de02 1203 0000 0000 2020 51',
    },
    token,
  )
  expect(res.status).toBe(201)
  return body(res)
}

const importInto = (accountId: string, transactions: Json[], token: string) =>
  request('POST', `/v1/accounts/${accountId}/imports`, { transactions }, token)

const subscription = (bookingDate: string) => ({
  bookingDate,
  amountCents: -1299,
  counterpartyName: 'Streamingdienst Beispiel',
  purpose: `Abo ${bookingDate.slice(0, 7)}`,
})

describe('Haushalte', () => {
  it('legt beim Anlegen einer Person ihren privaten Haushalt an', async () => {
    const a = await personWithSession('Person A')
    const res = await request('GET', '/v1/households', undefined, a.token)
    expect(res.status).toBe(200)
    expect((await body(res)).items).toEqual([
      {
        id: expect.any(String),
        kind: 'privat',
        name: 'Person A',
        members: [{ id: a.person.id, displayName: 'Person A' }],
      },
    ])
  })

  it('zeigt den gemeinsamen Haushalt beiden, den privaten nur der eigenen Person', async () => {
    const a = await personWithSession('Person A')
    const b = await personWithSession('Person B')
    await ledger.createSharedHousehold('Gemeinsam', [a.person.id, b.person.id])

    const forA = (await body(await request('GET', '/v1/households', undefined, a.token))).items
    const forB = (await body(await request('GET', '/v1/households', undefined, b.token))).items
    expect(forA.map((h: Json) => [h.kind, h.name])).toEqual([
      ['privat', 'Person A'],
      ['gemeinsam', 'Gemeinsam'],
    ])
    expect(forB.map((h: Json) => [h.kind, h.name])).toEqual([
      ['privat', 'Person B'],
      ['gemeinsam', 'Gemeinsam'],
    ])
    expect(forA[1].members).toHaveLength(2)
  })

  it('erlaubt höchstens einen gemeinsamen Haushalt', async () => {
    const a = await personWithSession('Person A')
    const b = await personWithSession('Person B')
    await ledger.createSharedHousehold('Gemeinsam', [a.person.id, b.person.id])
    await expect(
      ledger.createSharedHousehold('Noch einer', [a.person.id, b.person.id]),
    ).rejects.toThrow()
  })

  it('verlangt eine Anmeldung', async () => {
    expect((await request('GET', '/v1/households')).status).toBe(401)
    expect((await request('GET', '/v1/accounts')).status).toBe(401)
    expect((await request('GET', '/v1/recurring')).status).toBe(401)
  })
})

describe('Konten', () => {
  it('legt ein Bankkonto mit normalisierter IBAN an', async () => {
    const a = await personWithSession('Person A')
    const account = await bankAccount(a.token)
    expect(account).toMatchObject({
      name: 'Girokonto',
      source: 'bank',
      iban: 'DE02120300000000202051',
      currency: 'EUR',
      lastImportAt: null,
    })
    const list = await body(await request('GET', '/v1/accounts', undefined, a.token))
    expect(list.items.map((x: Json) => x.id)).toEqual([account.id])
  })

  it('lehnt ungültige IBANs und IBANs bei Bargeld ab', async () => {
    const a = await personWithSession('Person A')
    const householdId = await privateHousehold(a.token)
    const bad = await request(
      'POST',
      '/v1/accounts',
      { householdId, name: 'X', source: 'bank', iban: 'keine' },
      a.token,
    )
    expect(bad.status).toBe(400)
    const cash = await request(
      'POST',
      '/v1/accounts',
      { householdId, name: 'Portemonnaie', source: 'bar', iban: 'DE02120300000000202051' },
      a.token,
    )
    expect(cash.status).toBe(422)
    expect((await body(cash)).error.code).toBe('iban_bei_bargeld')
  })

  it('lässt keine Konten im privaten Haushalt einer anderen Person anlegen', async () => {
    const a = await personWithSession('Person A')
    const b = await personWithSession('Person B')
    const res = await request(
      'POST',
      '/v1/accounts',
      { householdId: await privateHousehold(a.token), name: 'Fremd', source: 'bank' },
      b.token,
    )
    expect(res.status).toBe(404)
    expect((await body(res)).error.code).toBe('haushalt_nicht_gefunden')
  })
})

describe('Import', () => {
  it('übernimmt Buchungen und überspringt sie beim zweiten Abruf', async () => {
    const a = await personWithSession('Person A')
    const account = await bankAccount(a.token)
    const batch = [
      { sourceId: 'B-1', bookingDate: '2026-11-02', amountCents: -2_340, purpose: 'Einkauf' },
      {
        bookingDate: '2026-11-03',
        valueDate: '2026-11-04',
        amountCents: 312_045,
        counterpartyName: '  Arbeitgeber   Beispiel AG ',
        counterpartyIban: 'DE02 1203 0000 0000 2020 51',
        purpose: 'Gehalt\nNovember',
      },
    ]

    const first = await importInto(account.id, batch, a.token)
    expect(first.status).toBe(201)
    expect(await body(first)).toMatchObject({ received: 2, imported: 2, skipped: 0 })

    const second = await body(await importInto(account.id, batch, a.token))
    expect(second).toMatchObject({ received: 2, imported: 0, skipped: 2 })

    const list = await body(
      await request('GET', `/v1/accounts/${account.id}/transactions`, undefined, a.token),
    )
    expect(list.items).toHaveLength(2)
    expect(list.items[0]).toMatchObject({
      bookingDate: '2026-11-03',
      valueDate: '2026-11-04',
      amountCents: 312_045,
      counterpartyName: 'Arbeitgeber Beispiel AG',
      counterpartyIban: 'DE02120300000000202051',
      purpose: 'Gehalt November',
      status: 'importiert',
      sourceId: null,
    })
    expect(list.items[1]).toMatchObject({ sourceId: 'B-1', amountCents: -2_340 })

    const accounts = await body(await request('GET', '/v1/accounts', undefined, a.token))
    expect(accounts.items[0].lastImportAt).not.toBeNull()
  })

  it('behandelt überlappende Abrufe mit gleichen Buchungen am selben Tag richtig', async () => {
    const a = await personWithSession('Person A')
    const account = await bankAccount(a.token)
    const coffee = { bookingDate: '2026-11-10', amountCents: -450, purpose: 'Café Beispiel' }

    // Mittags ist erst ein Kaffee gebucht, abends sind es zwei.
    expect(await body(await importInto(account.id, [coffee], a.token))).toMatchObject({
      imported: 1,
    })
    const evening = [
      { bookingDate: '2026-11-09', amountCents: -1_000, purpose: 'Bäckerei' },
      coffee,
      coffee,
    ]
    expect(await body(await importInto(account.id, evening, a.token))).toMatchObject({
      received: 3,
      imported: 2,
      skipped: 1,
    })
    const [row] = await db`select count(*)::int as n from transactions`
    expect(row?.n).toBe(3)
  })

  it('verweigert den Import in fremde Konten und Bargeldkonten', async () => {
    const a = await personWithSession('Person A')
    const b = await personWithSession('Person B')
    const account = await bankAccount(a.token)
    const foreign = await importInto(account.id, [subscription('2026-11-01')], b.token)
    expect(foreign.status).toBe(404)
    expect((await body(foreign)).error.code).toBe('konto_nicht_gefunden')

    const cash = await body(
      await request(
        'POST',
        '/v1/accounts',
        { householdId: await privateHousehold(a.token), name: 'Portemonnaie', source: 'bar' },
        a.token,
      ),
    )
    const res = await importInto(cash.id, [subscription('2026-11-01')], a.token)
    expect(res.status).toBe(422)
    expect((await body(res)).error.code).toBe('import_bei_bargeld')
  })

  it('prüft Datum, Betrag und Währung', async () => {
    const a = await personWithSession('Person A')
    const account = await bankAccount(a.token)
    for (const t of [
      { bookingDate: '2026-02-30', amountCents: -100 },
      { bookingDate: '2026-11-01', amountCents: -1.5 },
      { bookingDate: '2026-11-01', amountCents: -100, currency: 'USD' },
    ]) {
      expect((await importInto(account.id, [t], a.token)).status).toBe(400)
    }
  })

  it('importiert in Konten des gemeinsamen Haushalts für beide', async () => {
    const a = await personWithSession('Person A')
    const b = await personWithSession('Person B')
    const shared = await ledger.createSharedHousehold('Gemeinsam', [a.person.id, b.person.id])
    const account = await bankAccount(a.token, shared.id)
    expect((await importInto(account.id, [subscription('2026-11-01')], b.token)).status).toBe(201)
    const forA = await body(
      await request('GET', `/v1/accounts/${account.id}/transactions`, undefined, a.token),
    )
    expect(forA.items).toHaveLength(1)
  })
})

describe('Privatsphäre', () => {
  it('zeigt der anderen Person weder Konten noch Buchungen noch Serien', async () => {
    const a = await personWithSession('Person A')
    const b = await personWithSession('Person B')
    await ledger.createSharedHousehold('Gemeinsam', [a.person.id, b.person.id])
    const account = await bankAccount(a.token)
    await importInto(
      account.id,
      ['2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01'].map(subscription),
      a.token,
    )

    expect((await body(await request('GET', '/v1/accounts', undefined, b.token))).items).toEqual([])
    expect((await body(await request('GET', '/v1/recurring', undefined, b.token))).items).toEqual(
      [],
    )
    const tx = await request('GET', `/v1/accounts/${account.id}/transactions`, undefined, b.token)
    expect(tx.status).toBe(404)
    // Auch über den Filter lässt sich nichts erfragen.
    const filtered = await request(
      'GET',
      `/v1/recurring?accountId=${account.id}`,
      undefined,
      b.token,
    )
    expect((await body(filtered)).items).toEqual([])
  })
})

describe('Wiederkehrende Buchungen', () => {
  it('erkennt nach dem Import eine Serie und verknüpft die Buchungen', async () => {
    const a = await personWithSession('Person A')
    const account = await bankAccount(a.token)
    const months = ['2026-08-01', '2026-09-01', '2026-10-01']
    const res = await body(await importInto(account.id, months.map(subscription), a.token))
    expect(res.recurring.active + res.recurring.ended).toBe(1)

    const { items } = await body(await request('GET', '/v1/recurring', undefined, a.token))
    expect(items).toHaveLength(1)
    const [series] = items
    expect(series).toMatchObject({
      accountId: account.id,
      counterparty: 'Streamingdienst Beispiel',
      direction: 'ausgang',
      cadence: 'monatlich',
      typicalAmountCents: -1299,
      occurrences: 3,
      lastDate: '2026-10-01',
      nextExpectedDate: '2026-11-01',
    })

    // Weitere Buchung: dieselbe Serie (gleiche ID) wird fortgeschrieben.
    await importInto(account.id, [subscription('2026-11-01')], a.token)
    const after = (await body(await request('GET', '/v1/recurring', undefined, a.token))).items
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ id: series.id, occurrences: 4, lastDate: '2026-11-01' })

    const txs = await body(
      await request('GET', `/v1/accounts/${account.id}/transactions`, undefined, a.token),
    )
    expect(txs.items.every((t: Json) => t.recurringSeriesId === series.id)).toBe(true)
  })

  it('setzt den Stichtag für „beendet“ beim Import', async () => {
    const a = await personWithSession('Person A')
    const account = await bankAccount(a.token)
    await ledger.importTransactions(
      a.person.id,
      account.id,
      ['2026-01-01', '2026-02-01', '2026-03-01'].map(subscription),
      '2026-11-17',
    )
    const ended = await body(
      await request('GET', '/v1/recurring?state=beendet', undefined, a.token),
    )
    expect(ended.items).toHaveLength(1)
    const active = await body(await request('GET', '/v1/recurring?state=aktiv', undefined, a.token))
    expect(active.items).toEqual([])
  })
})
