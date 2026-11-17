import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type {
  LlmCategorizer,
  LlmOption,
  LlmRequest,
  LlmSuggestion,
  LlmTransaction,
} from '../src/categorize/llm.js'
import { OpenRouterCategorizer } from '../src/categorize/openrouter.js'
import { bestRule, criteriaFromCorrection, matches, type Rule } from '../src/categorize/rules.js'
import {
  LLM_BATCH_SIZE,
  LLM_CONCURRENCY,
  LLM_MAX_FAILURES_IN_ROW,
  maskIbans,
} from '../src/categorize/service.js'
import { setupTestApp } from './helpers/app.js'

// Alle Namen, Beträge und IBANs sind erfunden.

/**
 * LLM-Ersatz: merkt sich die Anfragen und antwortet je Buchung, was der Test vorgibt
 * (`llmAnswer`), oder für die ganze Anfrage (`llmBatch`). Wirft `llmAnswer`, scheitert die
 * ganze Anfrage.
 */
const llmCalls: LlmRequest[] = []
let llmAnswer: (t: LlmTransaction, options: LlmOption[]) => LlmSuggestion | null = () => null
let llmBatch: ((req: LlmRequest) => Promise<(LlmSuggestion | null)[]>) | null = null
const fakeLlm: LlmCategorizer = {
  async suggest(req) {
    llmCalls.push(req)
    if (llmBatch) return llmBatch(req)
    return req.transactions.map((t) => llmAnswer(t, req.options))
  },
}
const pick = (options: LlmOption[], label: string) =>
  options.find((o) => o.label === label)?.potId ?? null

const { db, categorize, ledger, request, reset, personWithSession } = setupTestApp({
  llm: fakeLlm,
})

afterAll(() => db.end())
beforeEach(async () => {
  // Hintergrundläufe des vorigen Tests abwarten, bevor die Tabellen geleert werden.
  await categorize.llmIdle()
  await reset()
  llmCalls.length = 0
  llmAnswer = () => null
  llmBatch = null
})

type Json = Record<string, any>
const body = async (res: Response): Promise<Json> => (await res.json()) as Json

async function setup(name = 'Person A') {
  const p = await personWithSession(name)
  const { items } = await body(await request('GET', '/v1/households', undefined, p.token))
  const householdId = items.find((h: Json) => h.kind === 'privat').id as string
  const account = await body(
    await request('POST', '/v1/accounts', { householdId, name: 'Giro', source: 'bank' }, p.token),
  )
  return { ...p, householdId, accountId: account.id as string }
}

async function pot(token: string, householdId: string, name: string): Promise<string> {
  const res = await request(
    'POST',
    `/v1/households/${householdId}/pots`,
    { name, kind: 'monatlich' },
    token,
  )
  expect(res.status).toBe(201)
  return (await body(res)).id
}

const importInto = (token: string, accountId: string, transactions: Json[]) =>
  request('POST', `/v1/accounts/${accountId}/imports`, { transactions }, token)

const pending = async (token: string) =>
  (await body(await request('GET', '/v1/transactions/pending', undefined, token))).items as Json[]

const grocery = (bookingDate: string, amountCents = -4_250) => ({
  bookingDate,
  amountCents,
  counterpartyName: 'Supermarkt  Beispiel',
  purpose: `Einkauf ${bookingDate}`,
})

describe('Regeln (rein)', () => {
  const rule = (extra: Partial<Rule>): Rule => ({
    id: 'r',
    householdId: 'h',
    accountId: null,
    direction: null,
    counterpartyIban: null,
    counterpartyName: null,
    purposeContains: null,
    minAmountCents: null,
    maxAmountCents: null,
    kind: 'einnahme',
    potId: null,
    personId: null,
    counterAccountId: null,
    origin: 'manuell',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...extra,
  })
  const t = {
    accountId: 'a',
    amountCents: -999,
    counterpartyName: 'Bäckerei  BEISPIEL',
    counterpartyIban: null,
    purpose: 'Kartenzahlung Brötchen',
  }

  it('vergleicht Namen ohne Groß-/Kleinschreibung und Leerraum', () => {
    expect(matches(rule({ counterpartyName: 'bäckerei beispiel' }), t)).toBe(true)
    expect(matches(rule({ purposeContains: 'BRÖTCHEN' }), t)).toBe(true)
    expect(matches(rule({ direction: 'eingang', counterpartyName: 'Bäckerei Beispiel' }), t)).toBe(
      false,
    )
    expect(matches(rule({ maxAmountCents: -1_000 }), t)).toBe(false)
    expect(matches(rule({}), t)).toBe(false)
  })

  it('nimmt die spezifischste, bei Gleichstand die neueste Regel', () => {
    const broad = rule({ id: 'breit', purposeContains: 'kartenzahlung' })
    const narrow = rule({ id: 'eng', purposeContains: 'kartenzahlung', direction: 'ausgang' })
    const newer = rule({
      id: 'neu',
      counterpartyName: 'bäckerei beispiel',
      direction: 'ausgang',
      updatedAt: new Date(1),
    })
    expect(bestRule([broad, narrow], t)?.id).toBe('eng')
    expect(bestRule([broad, narrow, newer], t)?.id).toBe('neu')
  })

  it('leitet aus einer Korrektur Richtung und Gegenpartei ab', () => {
    expect(criteriaFromCorrection(t)).toMatchObject({
      direction: 'ausgang',
      counterpartyName: 'Bäckerei BEISPIEL',
      counterpartyIban: null,
    })
    expect(
      criteriaFromCorrection({ ...t, counterpartyIban: 'DE02120300000000202051' }),
    ).toMatchObject({ counterpartyIban: 'DE02120300000000202051', counterpartyName: null })
    // Ohne Gegenpartei (z. B. Depotbank ohne Angaben) entsteht keine Regel.
    expect(criteriaFromCorrection({ ...t, counterpartyName: null })).toBeNull()
  })
})

describe('Bestätigen und korrigieren', () => {
  it('macht aus einer Korrektur eine Regel und schlägt danach selbst vor', async () => {
    const a = await setup()
    const essen = await pot(a.token, a.householdId, 'Lebensmittel')
    await importInto(a.token, a.accountId, [grocery('2026-11-02'), grocery('2026-11-05', -1_999)])

    const open = await pending(a.token)
    expect(open.map((t) => t.status)).toEqual(['importiert', 'importiert'])
    expect(open[0]).toMatchObject({ splits: [], suggestion: null })

    // Ohne Vorschlag gibt es nichts mit einem Tipp zu bestätigen.
    const nothing = await request(
      'POST',
      `/v1/transactions/${open[0]?.id}/confirm`,
      undefined,
      a.token,
    )
    expect(nothing.status).toBe(409)

    const res = await request(
      'PUT',
      `/v1/transactions/${open[0]?.id}/splits`,
      { splits: [{ kind: 'topf', potId: essen, amountCents: -1_999 }] },
      a.token,
    )
    expect(res.status).toBe(200)
    const result = await body(res)
    expect(result.transaction).toMatchObject({
      status: 'bestaetigt',
      splits: [{ kind: 'topf', potId: essen, amountCents: -1_999 }],
    })
    expect(result.rule).toMatchObject({
      origin: 'korrektur',
      direction: 'ausgang',
      counterpartyName: 'Supermarkt Beispiel',
      kind: 'topf',
      potId: essen,
    })
    // Die andere offene Buchung derselben Gegenpartei hat jetzt einen Vorschlag.
    expect(result.resuggested).toBe(1)
    const [other] = await pending(a.token)
    expect(other).toMatchObject({
      status: 'vorgeschlagen',
      splits: [{ kind: 'topf', potId: essen, amountCents: -4_250 }],
      suggestion: { source: 'regel', kind: 'topf', potId: essen, confidencePct: 100 },
    })
    expect(other?.suggestion.reason).toContain('Supermarkt Beispiel')

    // Vorschlag zählt schon im Budget, bevor jemand bestätigt.
    const month = await body(
      await request('GET', `/v1/households/${a.householdId}/budget/2026-11`, undefined, a.token),
    )
    expect(month.pots[0].activityCents).toBe(-6_249)

    // Neue Buchungen derselben Gegenpartei kommen gleich mit Vorschlag.
    await importInto(a.token, a.accountId, [grocery('2026-11-09', -800)])
    expect((await pending(a.token)).map((t) => t.status)).toEqual([
      'vorgeschlagen',
      'vorgeschlagen',
    ])

    // Ein Tipp bestätigt.
    const ok = await request('POST', `/v1/transactions/${other?.id}/confirm`, undefined, a.token)
    expect(ok.status).toBe(200)
    expect((await body(ok)).status).toBe('bestaetigt')
    expect(await pending(a.token)).toHaveLength(1)
  })

  it('lenkt eine bestehende Regel bei erneuter Korrektur um, statt eine zweite anzulegen', async () => {
    const a = await setup()
    const essen = await pot(a.token, a.householdId, 'Lebensmittel')
    const haushalt = await pot(a.token, a.householdId, 'Haushalt')
    await importInto(a.token, a.accountId, [grocery('2026-11-02'), grocery('2026-11-03')])
    const [first, second] = await pending(a.token)
    await request(
      'PUT',
      `/v1/transactions/${first?.id}/splits`,
      { splits: [{ kind: 'topf', potId: essen, amountCents: -4_250 }] },
      a.token,
    )
    const res = await body(
      await request(
        'PUT',
        `/v1/transactions/${second?.id}/splits`,
        { splits: [{ kind: 'topf', potId: haushalt, amountCents: -4_250 }] },
        a.token,
      ),
    )
    expect(res.rule.potId).toBe(haushalt)
    const rules = await body(
      await request('GET', `/v1/households/${a.householdId}/rules`, undefined, a.token),
    )
    expect(rules.items).toHaveLength(1)
  })

  it('teilt eine Buchung auf mehrere Töpfe auf, ohne daraus eine Regel zu machen', async () => {
    const a = await setup()
    const essen = await pot(a.token, a.householdId, 'Lebensmittel')
    const drogerie = await pot(a.token, a.householdId, 'Drogerie')
    await importInto(a.token, a.accountId, [grocery('2026-11-02', -5_000)])
    const [t] = await pending(a.token)

    const wrong = await request(
      'PUT',
      `/v1/transactions/${t?.id}/splits`,
      {
        splits: [
          { kind: 'topf', potId: essen, amountCents: -3_000 },
          { kind: 'topf', potId: drogerie, amountCents: -1_000 },
        ],
      },
      a.token,
    )
    expect(wrong.status).toBe(422)
    expect((await body(wrong)).error.code).toBe('aufteilung_summe')

    const missingPot = await request(
      'PUT',
      `/v1/transactions/${t?.id}/splits`,
      { splits: [{ kind: 'topf', potId: null, amountCents: -5_000 }] },
      a.token,
    )
    expect(missingPot.status).toBe(422)

    // Ohne potId gilt null (der Swift-Client lässt leere Felder weg).
    const withoutPotId = await request(
      'PUT',
      `/v1/transactions/${t?.id}/splits`,
      { splits: [{ kind: 'umbuchung', amountCents: -5_000 }], learn: false },
      a.token,
    )
    expect(withoutPotId.status).toBe(200)
    expect((await body(withoutPotId)).transaction.splits).toEqual([
      {
        kind: 'umbuchung',
        potId: null,
        personId: null,
        counterAccountId: null,
        amountCents: -5_000,
      },
    ])

    const ok = await body(
      await request(
        'PUT',
        `/v1/transactions/${t?.id}/splits`,
        {
          splits: [
            { kind: 'topf', potId: essen, amountCents: -3_500 },
            { kind: 'topf', potId: drogerie, amountCents: -1_500 },
          ],
        },
        a.token,
      ),
    )
    expect(ok.rule).toBeNull()
    expect(ok.transaction.splits).toHaveLength(2)
  })

  it('lernt nicht, wenn learn = false', async () => {
    const a = await setup()
    const essen = await pot(a.token, a.householdId, 'Lebensmittel')
    await importInto(a.token, a.accountId, [grocery('2026-11-02')])
    const [t] = await pending(a.token)
    const res = await body(
      await request(
        'PUT',
        `/v1/transactions/${t?.id}/splits`,
        { splits: [{ kind: 'topf', potId: essen, amountCents: -4_250 }], learn: false },
        a.token,
      ),
    )
    expect(res.rule).toBeNull()
  })
})

describe('Privatsphäre', () => {
  it('lässt die andere Person nichts sehen, bestätigen oder zuordnen', async () => {
    const a = await setup('Person A')
    const b = await setup('Person B')
    await ledger.createSharedHousehold('Gemeinsam', [a.person.id, b.person.id])
    const essenA = await pot(a.token, a.householdId, 'Lebensmittel')
    const essenB = await pot(b.token, b.householdId, 'Lebensmittel')
    await importInto(a.token, a.accountId, [grocery('2026-11-02')])
    const [t] = await pending(a.token)

    expect(await pending(b.token)).toEqual([])
    expect(
      (await request('POST', `/v1/transactions/${t?.id}/confirm`, undefined, b.token)).status,
    ).toBe(404)
    expect(
      (
        await request(
          'PUT',
          `/v1/transactions/${t?.id}/splits`,
          { splits: [{ kind: 'topf', potId: essenB, amountCents: -4_250 }] },
          b.token,
        )
      ).status,
    ).toBe(404)
    expect(
      (await request('GET', `/v1/households/${a.householdId}/rules`, undefined, b.token)).status,
    ).toBe(404)

    // A darf keinen Topf aus einem anderen Haushalt verwenden (Ausgleich kommt mit E4).
    const foreign = await request(
      'PUT',
      `/v1/transactions/${t?.id}/splits`,
      { splits: [{ kind: 'topf', potId: essenB, amountCents: -4_250 }] },
      a.token,
    )
    expect(foreign.status).toBe(422)
    expect((await body(foreign)).error.code).toBe('topf_anderer_haushalt')

    // Regeln von A lassen sich von B nicht löschen.
    const created = await body(
      await request(
        'POST',
        `/v1/households/${a.householdId}/rules`,
        { purposeContains: 'Einkauf', kind: 'topf', potId: essenA },
        a.token,
      ),
    )
    expect(
      (await request('DELETE', `/v1/rules/${created.rule.id}`, undefined, b.token)).status,
    ).toBe(404)
    expect(
      (await request('DELETE', `/v1/rules/${created.rule.id}`, undefined, a.token)).status,
    ).toBe(204)
  })

  it('prüft die Invarianten der Aufteilung auch in der Datenbank', async () => {
    const a = await setup('Person A')
    const b = await setup('Person B')
    const essenB = await pot(b.token, b.householdId, 'Lebensmittel')
    const essenA = await pot(a.token, a.householdId, 'Lebensmittel')
    await importInto(a.token, a.accountId, [grocery('2026-11-02')])
    const [t] = await pending(a.token)

    await expect(
      db.begin(
        (tx) =>
          tx`insert into transaction_splits (transaction_id, kind, pot_id, amount_cents)
             values (${t?.id}, 'topf', ${essenA}, -1)`,
      ),
    ).rejects.toThrow(/Summe der Aufteilungen/)
    await expect(
      db.begin(
        (tx) =>
          tx`insert into transaction_splits (transaction_id, kind, pot_id, amount_cents)
             values (${t?.id}, 'topf', ${essenB}, -4250)`,
      ),
    ).rejects.toThrow(/Haushalt des Kontos/)
  })
})

describe('Regeln von Hand', () => {
  it('wendet eine neue Regel gleich auf offene Buchungen an', async () => {
    const a = await setup()
    await importInto(a.token, a.accountId, [
      { bookingDate: '2026-11-01', amountCents: 250_000, counterpartyName: 'Arbeitgeber Beispiel' },
      grocery('2026-11-02'),
    ])
    const res = await request(
      'POST',
      `/v1/households/${a.householdId}/rules`,
      { counterpartyName: 'arbeitgeber beispiel', direction: 'eingang', kind: 'einnahme' },
      a.token,
    )
    expect(res.status).toBe(201)
    expect((await body(res)).resuggested).toBe(1)
    const month = await body(
      await request('GET', `/v1/households/${a.householdId}/budget/2026-11`, undefined, a.token),
    )
    expect(month.inflowsCents).toBe(250_000)

    const empty = await request(
      'POST',
      `/v1/households/${a.householdId}/rules`,
      { kind: 'einnahme' },
      a.token,
    )
    expect(empty.status).toBe(422)
    expect((await body(empty)).error.code).toBe('regel_ohne_merkmal')
  })
})

describe('LLM-Vorschläge', () => {
  it('fragt ohne Regeltreffer das LLM und speichert Vorschlag mit Begründung', async () => {
    const a = await setup('Person A')
    const b = await setup('Person B')
    const essen = await pot(a.token, a.householdId, 'Lebensmittel')
    await pot(b.token, b.householdId, 'Nur bei B')
    llmAnswer = (_t, options) => ({
      kind: 'topf',
      potId: pick(options, 'Lebensmittel'),
      confidencePct: 82,
      reason: 'Supermarkt, also vermutlich Lebensmittel.',
    })

    await importInto(a.token, a.accountId, [
      { ...grocery('2026-11-02'), counterpartyIban: 'DE02120300000000202051' },
    ])
    await categorize.llmIdle()
    expect(llmCalls).toHaveLength(1)
    const [call] = llmCalls
    // Nur Töpfe des eigenen Haushalts, keine IBAN.
    expect(call?.options.map((o) => o.label)).toEqual([
      'Einnahme (Noch ohne Aufgabe)',
      'Umbuchung zwischen eigenen Konten',
      'Lebensmittel',
    ])
    expect(JSON.stringify(call)).not.toContain('DE02')

    const [t] = await pending(a.token)
    expect(t).toMatchObject({
      status: 'vorgeschlagen',
      splits: [{ kind: 'topf', potId: essen, amountCents: -4_250 }],
      suggestion: {
        source: 'llm',
        confidencePct: 82,
        reason: 'Supermarkt, also vermutlich Lebensmittel.',
        ruleId: null,
      },
    })
  })

  it('antwortet beim Import sofort und bündelt große Importe', async () => {
    const a = await setup()
    await pot(a.token, a.householdId, 'Lebensmittel')
    // Das Modell hängt, bis der Test es freigibt.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let inFlight = 0
    let maxInFlight = 0
    llmBatch = async (req) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await gate
      inFlight--
      return req.transactions.map(() => null)
    }
    const count = 1_000
    const transactions = Array.from({ length: count }, (_, i) => ({
      bookingDate: `2026-${String((i % 10) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      amountCents: -(100 + i),
      counterpartyName: `Laden ${i}`,
      purpose: `Einkauf Nr. ${i}`,
    }))

    const res = await importInto(a.token, a.accountId, transactions)
    expect(res.status).toBe(201)
    expect((await body(res)).imported).toBe(count)
    // Der Import ist fertig, das Modell hat noch nicht geantwortet.
    const unanswered = await db<{ n: number }[]>`
      select count(*)::int as n from transactions where llm_checked_at is null
    `
    expect(unanswered[0]?.n).toBe(count)

    release()
    await categorize.llmIdle()
    expect(llmCalls).toHaveLength(Math.ceil(count / LLM_BATCH_SIZE))
    expect(llmCalls.every((c) => c.transactions.length <= LLM_BATCH_SIZE)).toBe(true)
    expect(maxInFlight).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(LLM_CONCURRENCY)
    const checked = await db<{ n: number }[]>`
      select count(*)::int as n from transactions where llm_checked_at is not null
    `
    expect(checked[0]?.n).toBe(count)
  })

  it('ordnet die Antworten eines Stapels den richtigen Buchungen zu', async () => {
    const a = await setup()
    const essen = await pot(a.token, a.householdId, 'Lebensmittel')
    llmAnswer = (t, options) =>
      t.amountCents > 0
        ? { kind: 'einnahme', potId: null, confidencePct: 95, reason: 'Gehalt.' }
        : t.counterpartyName === 'Unklar'
          ? null
          : {
              kind: 'topf',
              potId: pick(options, 'Lebensmittel'),
              confidencePct: 80,
              reason: 'Laden.',
            }
    const res = await importInto(a.token, a.accountId, [
      grocery('2026-11-02'),
      {
        bookingDate: '2026-11-01',
        amountCents: 300_000,
        counterpartyName: 'Arbeitgeberin Beispiel',
        purpose: 'Gehalt',
      },
      { bookingDate: '2026-11-03', amountCents: -999, counterpartyName: 'Unklar' },
    ])
    expect(res.status).toBe(201)
    await categorize.llmIdle()
    expect(llmCalls).toHaveLength(1)
    expect(llmCalls[0]?.transactions).toHaveLength(3)
    const byName = new Map((await pending(a.token)).map((t) => [t.counterpartyName, t]))
    expect(byName.get('Arbeitgeberin Beispiel')).toMatchObject({
      status: 'vorgeschlagen',
      splits: [{ kind: 'einnahme', potId: null, amountCents: 300_000 }],
    })
    expect(byName.get('Supermarkt Beispiel')).toMatchObject({
      status: 'vorgeschlagen',
      splits: [{ kind: 'topf', potId: essen }],
    })
    expect(byName.get('Unklar')).toMatchObject({ status: 'importiert', suggestion: null })
  })

  it('mischt beim Nachholen keine Haushalte in einer Anfrage', async () => {
    const a = await setup('Person A')
    const b = await setup('Person B')
    await pot(a.token, a.householdId, 'Nur bei A')
    await pot(b.token, b.householdId, 'Nur bei B')
    llmAnswer = () => {
      throw new Error('HTTP 503')
    }
    await importInto(a.token, a.accountId, [grocery('2026-11-02'), grocery('2026-11-03')])
    await importInto(b.token, b.accountId, [grocery('2026-11-04')])
    await categorize.llmIdle()
    llmCalls.length = 0
    llmAnswer = () => null

    await categorize.retryLlmSuggestions()
    expect(llmCalls).toHaveLength(2)
    const labels = llmCalls.map((c) => c.options.map((o) => o.label))
    expect(labels).toContainEqual(expect.arrayContaining(['Nur bei A']))
    expect(labels).toContainEqual(expect.arrayContaining(['Nur bei B']))
    for (const l of labels) {
      expect(l.includes('Nur bei A') && l.includes('Nur bei B')).toBe(false)
    }
    const sizes = llmCalls.map((c) => c.transactions.length).sort()
    expect(sizes).toEqual([1, 2])
  })

  it('holt nur Buchungen ab dem Budgetbeginn nach', async () => {
    const a = await setup()
    await db`update households set budget_start_month = '2026-11-01' where id = ${a.householdId}`
    llmAnswer = () => {
      throw new Error('HTTP 503')
    }
    // Ältere Buchungen zuerst importiert, also vorne beim Nachholen, wenn nichts filtert.
    await importInto(
      a.token,
      a.accountId,
      Array.from({ length: 5 }, (_, i) => grocery(`2026-10-${10 + i}`)),
    )
    await importInto(a.token, a.accountId, [grocery('2026-11-02')])
    await categorize.llmIdle()
    expect(llmCalls.map((c) => c.transactions.length)).toEqual([1])
    llmCalls.length = 0
    llmAnswer = () => null
    // Die Oktober-Buchungen belegen keinen Platz im Durchgang.
    await categorize.retryLlmSuggestions({ limit: 1 })
    expect(llmCalls.map((c) => c.transactions.map((t) => t.bookingDate))).toEqual([['2026-11-02']])
  })

  it('ignoriert ungültige Antworten und fragt nicht zweimal', async () => {
    const a = await setup()
    await pot(a.token, a.householdId, 'Lebensmittel')
    llmAnswer = () => ({
      kind: 'topf',
      potId: '00000000-0000-4000-8000-000000000000',
      confidencePct: 90,
      reason: 'Erfunden',
    })
    await importInto(a.token, a.accountId, [grocery('2026-11-02')])
    await categorize.llmIdle()
    const [t] = await pending(a.token)
    expect(t).toMatchObject({ status: 'importiert', suggestion: null })
    expect(llmCalls).toHaveLength(1)
    // Gleicher Import erneut: nichts Neues, kein weiterer Aufruf.
    await importInto(a.token, a.accountId, [grocery('2026-11-02')])
    await categorize.llmIdle()
    expect(await categorize.retryLlmSuggestions()).toBe(0)
    expect(llmCalls).toHaveLength(1)
  })

  it('schickt keine IBAN aus dem Verwendungszweck', async () => {
    const a = await setup()
    await importInto(a.token, a.accountId, [
      {
        bookingDate: '2026-11-03',
        amountCents: -80_000,
        counterpartyName: 'Vermieterin Beispiel',
        purpose: 'Miete November IBAN DE89 3704 0044 0532 0130 00 BIC COBADEFFXXX',
      },
    ])
    await categorize.llmIdle()
    expect(llmCalls[0]?.transactions[0]?.purpose).toBe('Miete November IBAN [IBAN] BIC COBADEFFXXX')
  })

  it('holt Vorschläge nach, wenn das Modell nicht erreichbar war', async () => {
    const a = await setup()
    await pot(a.token, a.householdId, 'Lebensmittel')
    llmAnswer = () => {
      throw new Error('Zeitüberschreitung')
    }
    const res = await importInto(a.token, a.accountId, [grocery('2026-11-02')])
    expect(res.status).toBe(201)
    await categorize.llmIdle()
    expect(llmCalls).toHaveLength(1)
    const [before] = await pending(a.token)
    expect(before).toMatchObject({ status: 'importiert', suggestion: null })

    llmAnswer = (_t, options) => ({
      kind: 'topf',
      potId: pick(options, 'Lebensmittel'),
      confidencePct: 70,
      reason: 'Supermarkt.',
    })
    expect(await categorize.retryLlmSuggestions()).toBe(1)
    const [after] = await pending(a.token)
    expect(after).toMatchObject({ status: 'vorgeschlagen', suggestion: { source: 'llm' } })
    // Einmal beantwortet: kein weiterer Aufruf beim nächsten Nachholen.
    expect(await categorize.retryLlmSuggestions()).toBe(0)
    expect(llmCalls).toHaveLength(2)
  })

  it('bricht nach mehreren Fehlern in Folge ab, statt jede Anfrage zu versuchen', async () => {
    const a = await setup()
    llmAnswer = () => {
      throw new Error('HTTP 503')
    }
    const count = 10 * LLM_BATCH_SIZE
    const res = await importInto(
      a.token,
      a.accountId,
      Array.from({ length: count }, (_, i) => ({
        ...grocery(`2026-11-${String((i % 28) + 1).padStart(2, '0')}`, -(100 + i)),
      })),
    )
    expect(res.status).toBe(201)
    expect((await body(res)).imported).toBe(count)
    await categorize.llmIdle()
    // Laufende Anfragen dürfen noch zu Ende gehen, neue beginnen nicht mehr.
    expect(llmCalls.length).toBeGreaterThanOrEqual(LLM_MAX_FAILURES_IN_ROW)
    expect(llmCalls.length).toBeLessThanOrEqual(LLM_MAX_FAILURES_IN_ROW + LLM_CONCURRENCY - 1)
    const unchecked = await db<{ n: number }[]>`
      select count(*)::int as n from transactions where llm_checked_at is null
    `
    expect(unchecked[0]?.n).toBe(count)
  })

  it('funktioniert mit dem OpenRouter-Adapter von Anfang bis Ende', async () => {
    const a = await setup()
    const essen = await pot(a.token, a.householdId, 'Lebensmittel')
    const sent: string[] = []
    const adapter = new OpenRouterCategorizer(
      {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-test',
        model: 'beispiel/modell',
        timeoutMs: 1_000,
        zeroDataRetention: true,
      },
      {
        fetch: async (_url, init) => {
          sent.push(String(init?.body))
          // o1 Einnahme, o2 Umbuchung, o3 Lebensmittel
          const content = JSON.stringify({
            antworten: [
              { buchung: 'b1', option: 'o3', confidence_pct: 77, reason: 'Einkauf im Supermarkt.' },
            ],
          })
          return Response.json({ choices: [{ message: { content } }] })
        },
      },
    )
    llmBatch = (req) => adapter.suggest(req)
    await importInto(a.token, a.accountId, [
      { ...grocery('2026-11-02'), counterpartyIban: 'DE02120300000000202051' },
    ])
    await categorize.llmIdle()
    expect(sent).toHaveLength(1)
    expect(sent[0]).not.toContain('DE02')
    expect(sent[0]).not.toContain(essen)
    const [t] = await pending(a.token)
    expect(t).toMatchObject({
      status: 'vorgeschlagen',
      splits: [{ kind: 'topf', potId: essen, amountCents: -4_250 }],
      suggestion: { source: 'llm', confidencePct: 77, reason: 'Einkauf im Supermarkt.' },
    })
    // Keine Buchungs-ID verlässt den Server.
    expect(sent[0]).not.toContain(t?.id)
  })

  it('überlässt Regeltreffer nicht dem LLM', async () => {
    const a = await setup()
    await request(
      'POST',
      `/v1/households/${a.householdId}/rules`,
      { purposeContains: 'Einkauf', kind: 'umbuchung' },
      a.token,
    )
    await importInto(a.token, a.accountId, [grocery('2026-11-02')])
    await categorize.llmIdle()
    expect(llmCalls).toHaveLength(0)
    const [t] = await pending(a.token)
    expect(t?.suggestion.source).toBe('regel')
  })
})

describe('IBANs maskieren', () => {
  it('erkennt IBANs mit und ohne Leerzeichen und lässt anderes stehen', () => {
    expect(maskIbans('DE89370400440532013000')).toBe('[IBAN]')
    expect(maskIbans('an AT61 1904 3002 3457 3201 Danke')).toBe('an [IBAN] Danke')
    expect(maskIbans('Rechnung RE-2026-0042 vom 03.11.')).toBe('Rechnung RE-2026-0042 vom 03.11.')
    expect(maskIbans('KARTE 1234 EUR 12,50')).toBe('KARTE 1234 EUR 12,50')
    expect(maskIbans(null)).toBeNull()
  })
})
