import { describe, expect, it } from 'vitest'
import {
  type AnalyticsPot,
  type AnalyticsSeries,
  type AnalyticsTransaction,
  agedOutflows,
  ageOfMoneyAt,
  anomalies,
  assetCosts,
  classify,
  flow,
  goalForecast,
  monthlyMetrics,
  runway,
} from '../src/analytics/compute.js'

// Alle Namen und Beträge sind erfunden.

const pots: AnalyticsPot[] = [
  { id: 'essen', name: 'Lebensmittel', kind: 'monatlich', groupName: 'Alltag', archived: false },
  { id: 'miete', name: 'Miete', kind: 'monatlich', groupName: 'Wohnen', archived: false },
  { id: 'kfz', name: 'Kfz', kind: 'ruecklage', groupName: null, archived: false },
  { id: 'depot', name: 'Investieren', kind: 'erst_ich', groupName: null, archived: false },
]
const kinds = new Map(pots.map((p) => [p.id, p.kind]))

let n = 0
function tx(
  bookingDate: string,
  amountCents: number,
  splits: AnalyticsTransaction['splits'] | 'einnahme' | string | null,
  extra: Partial<AnalyticsTransaction> = {},
): AnalyticsTransaction {
  const resolved =
    splits === null
      ? []
      : splits === 'einnahme'
        ? [{ kind: 'einnahme' as const, potId: null, amountCents }]
        : typeof splits === 'string'
          ? [{ kind: 'topf' as const, potId: splits, amountCents }]
          : splits
  return {
    id: `t${++n}`,
    bookingDate,
    amountCents,
    counterparty: null,
    recurringSeriesId: null,
    splits: resolved,
    ...extra,
  }
}

const salary = (date: string, cents = 300_000) =>
  tx(date, cents, 'einnahme', { counterparty: 'Arbeitgeber Beispiel GmbH' })

describe('Einordnung einer Buchung', () => {
  it('trennt Einkommen, Konsum, Erst ich und Umbuchung', () => {
    expect(classify(salary('2026-01-01'), kinds)).toMatchObject({
      incomeCents: 300_000,
      consumptionCents: 0,
    })
    expect(classify(tx('2026-01-02', -5_000, 'essen'), kinds)).toMatchObject({
      consumptionCents: 5_000,
      erstIchCents: 0,
    })
    expect(classify(tx('2026-01-02', -30_000, 'depot'), kinds)).toMatchObject({
      consumptionCents: 0,
      erstIchCents: 30_000,
    })
    expect(
      classify(
        tx('2026-01-02', -10_000, [{ kind: 'umbuchung', potId: null, amountCents: -10_000 }]),
        kinds,
      ),
    ).toMatchObject({ incomeCents: 0, consumptionCents: 0, erstIchCents: 0 })
  })

  it('zählt Erstattungen gegen den Konsum und Unzugeordnetes vorsichtig', () => {
    expect(classify(tx('2026-01-02', 2_000, 'essen'), kinds).consumptionCents).toBe(-2_000)
    expect(classify(tx('2026-01-02', -4_000, null), kinds)).toMatchObject({
      consumptionCents: 4_000,
      uncategorizedOutCents: 4_000,
    })
    expect(classify(tx('2026-01-02', 4_000, null), kinds)).toMatchObject({
      incomeCents: 0,
      uncategorizedInCents: 4_000,
    })
  })

  it('zählt Einzahlungen ins Gemeinsame als Abfluss, auf dem gemeinsamen Konto als Einkommen', () => {
    // privates Konto: Geld verlässt den Haushalt, ist aber kein Konsum aus eigenen Töpfen
    expect(
      classify(
        tx('2026-01-02', -100_000, [{ kind: 'einzahlung', potId: null, amountCents: -100_000 }]),
        kinds,
      ),
    ).toMatchObject({ incomeCents: 0, consumptionCents: 0, contributionsCents: 100_000 })
    // gemeinsames Konto: dieselbe Einzahlung ist Einkommen des gemeinsamen Haushalts
    expect(
      classify(
        tx('2026-01-02', 100_000, [{ kind: 'einzahlung', potId: null, amountCents: 100_000 }]),
        kinds,
      ),
    ).toMatchObject({ incomeCents: 100_000, consumptionCents: 0, contributionsCents: 0 })
  })

  it('lässt Ausgleich und privat bezahlte gemeinsame Ausgaben neutral (Forderung, kein Konsum)', () => {
    const neutral = {
      incomeCents: 0,
      consumptionCents: 0,
      erstIchCents: 0,
      contributionsCents: 0,
      uncategorizedOutCents: 0,
      uncategorizedInCents: 0,
    }
    // Topf eines anderen (des gemeinsamen) Haushalts
    expect(classify(tx('2026-01-05', -6_000, 'gemeinsam-lebensmittel'), kinds)).toMatchObject(
      neutral,
    )
    // Erstattung vom gemeinsamen Konto (privat: Eingang, gemeinsam: Ausgang)
    for (const amount of [6_000, -6_000]) {
      expect(
        classify(
          tx('2026-01-20', amount, [{ kind: 'ausgleich', potId: null, amountCents: amount }]),
          kinds,
        ),
      ).toMatchObject(neutral)
    }
    // Gemischt: nur der eigene Anteil ist Konsum
    expect(
      classify(
        tx('2026-01-06', -10_000, [
          { kind: 'topf', potId: 'gemeinsam-lebensmittel', amountCents: -4_000 },
          { kind: 'topf', potId: 'essen', amountCents: -6_000 },
        ]),
        kinds,
      ).consumptionCents,
    ).toBe(6_000)
  })

  it('zählt nur den Konsum wiederkehrender Ausgänge als Fixkosten (kein Sparplan)', () => {
    expect(
      classify(tx('2026-01-03', -90_000, 'miete', { recurringSeriesId: 's1' }), kinds)
        .fixedCostsCents,
    ).toBe(90_000)
    expect(
      classify(tx('2026-01-03', -20_000, 'depot', { recurringSeriesId: 's2' }), kinds)
        .fixedCostsCents,
    ).toBe(0)
  })
})

describe('Kennzahlen je Monat', () => {
  const data = [
    salary('2026-01-01'),
    tx('2026-01-03', -90_000, 'miete', { recurringSeriesId: 's1' }),
    tx('2026-01-10', -40_000, 'essen'),
    tx('2026-01-05', -30_000, 'depot'),
    salary('2026-02-01'),
    tx('2026-02-03', -90_000, 'miete', { recurringSeriesId: 's1' }),
    tx('2026-02-12', -60_000, 'essen'),
  ]

  it('rechnet Sparquote und Fixkostenanteil in Basispunkten', () => {
    const { months, totals } = monthlyMetrics(data, pots, '2026-01', '2026-03', '2026-03-15')
    expect(months.map((m) => m.month)).toEqual(['2026-01', '2026-02', '2026-03'])
    expect(months[0]).toMatchObject({
      incomeCents: 300_000,
      consumptionCents: 130_000,
      erstIchCents: 30_000,
      savedCents: 170_000,
      savingsRateBp: 5_667,
      fixedCostsCents: 90_000,
      fixedCostShareBp: 3_000,
    })
    expect(months[1]).toMatchObject({ savedCents: 150_000, savingsRateBp: 5_000 })
    // Monat ohne Einkommen: keine Quote statt Division durch null
    expect(months[2]).toMatchObject({ incomeCents: 0, savingsRateBp: null, fixedCostShareBp: null })
    expect(totals).toMatchObject({
      incomeCents: 600_000,
      savedCents: 320_000,
      savingsRateBp: 5_333,
    })
  })

  it('rechnet Einzahlungen ins Gemeinsame nicht als gespart', () => {
    const withContribution = [
      ...data,
      tx('2026-01-02', -60_000, [{ kind: 'einzahlung', potId: null, amountCents: -60_000 }]),
    ]
    const { months } = monthlyMetrics(withContribution, pots, '2026-01', '2026-01', '2026-01-31')
    expect(months[0]).toMatchObject({
      incomeCents: 300_000,
      consumptionCents: 130_000,
      contributionsCents: 60_000,
      // 300 000 − 130 000 Konsum − 60 000 Einzahlung
      savedCents: 110_000,
      savingsRateBp: 3_667,
      fixedCostShareBp: 3_000,
    })
  })

  it('zeigt kein Alter des Geldes für Monate in der Zukunft', () => {
    const { months } = monthlyMetrics(data, pots, '2026-02', '2026-04', '2026-03-15')
    expect(months[0]?.ageOfMoneyDays).not.toBeNull()
    expect(months[2]?.ageOfMoneyDays).toBeNull()
  })
})

describe('Alter des Geldes', () => {
  it('verbraucht die ältesten Eingänge zuerst und gewichtet nach Betrag', () => {
    const aged = agedOutflows([
      tx('2026-01-01', 10_000, 'einnahme'),
      tx('2026-01-11', 10_000, 'einnahme'),
      // 5 000 aus dem ersten Eingang (20 Tage alt)
      tx('2026-01-21', -5_000, 'essen'),
      // 5 000 aus dem ersten (30 Tage) und 5 000 aus dem zweiten (20 Tage) → 25
      tx('2026-01-31', -10_000, 'essen'),
    ])
    expect(aged).toEqual([
      { date: '2026-01-21', ageDays: 20 },
      { date: '2026-01-31', ageDays: 25 },
    ])
    expect(ageOfMoneyAt(aged, '2026-01-25')).toBe(20)
    expect(ageOfMoneyAt(aged, '2026-02-01')).toBe(23)
    expect(ageOfMoneyAt(aged, '2025-12-31')).toBeNull()
  })

  it('übergeht Umbuchungen und Ausgänge ohne bekannten Eingang', () => {
    const aged = agedOutflows([
      tx('2026-01-01', -1_000, 'essen'),
      tx('2026-01-02', 5_000, 'einnahme'),
      tx('2026-01-03', -2_000, [{ kind: 'umbuchung', potId: null, amountCents: -2_000 }]),
      tx('2026-01-12', -1_000, 'essen'),
    ])
    expect(aged).toEqual([{ date: '2026-01-12', ageDays: 10 }])
  })

  it('nimmt den Durchschnitt der letzten 10 Ausgänge', () => {
    const txs = [tx('2026-01-01', 100_000, 'einnahme')]
    for (let d = 2; d <= 13; d++) {
      txs.push(tx(`2026-01-${String(d).padStart(2, '0')}`, -100, 'essen'))
    }
    // Alter 1 … 12 Tage; die letzten 10 sind 3 … 12 → 7,5 → 8
    expect(ageOfMoneyAt(agedOutflows(txs), '2026-01-31')).toBe(8)
  })
})

describe('Runway', () => {
  it('teilt das Geld durch den Konsum der letzten abgeschlossenen Monate', () => {
    const data = [
      tx('2026-01-10', -100_000, 'essen'),
      tx('2026-02-10', -200_000, 'essen'),
      tx('2026-02-11', -50_000, 'depot'),
      tx('2026-03-10', -999_999, 'essen'), // laufender Monat zählt nicht
    ]
    expect(runway(data, pots, 600_000, '2026-03-15')).toEqual({
      cashCents: 600_000,
      averageMonthlyConsumptionCents: 150_000,
      basedOnMonths: 2,
      months: 4,
    })
  })

  it('nimmt höchstens die letzten 6 Monate und liefert ohne Historie nichts', () => {
    const data = [tx('2025-01-10', -1_000_000, 'essen'), tx('2026-02-10', -60_000, 'essen')]
    expect(runway(data, pots, 100_000, '2026-03-15')).toMatchObject({
      averageMonthlyConsumptionCents: 10_000,
      basedOnMonths: 6,
      months: 10,
    })
    expect(runway([tx('2026-03-01', -1, 'essen')], pots, 100, '2026-03-15')).toMatchObject({
      months: null,
      basedOnMonths: 0,
    })
  })
})

describe('Geldfluss', () => {
  it('führt Quellen über den Haushalt zu Gruppen und Töpfen, ausgeglichen', () => {
    const data = [
      salary('2026-01-01'),
      tx('2026-01-02', 20_000, 'einnahme', { counterparty: 'Nebenjob Beispiel' }),
      tx('2026-01-03', -90_000, 'miete'),
      tx('2026-01-10', -40_000, 'essen'),
      tx('2026-01-11', 1_000, 'essen'),
      tx('2026-01-05', -30_000, 'depot'),
      tx('2026-01-20', -5_000, null),
      tx('2026-02-01', -1, 'essen'), // außerhalb
    ]
    const f = flow(data, pots, 'Person A', '2026-01', '2026-01')
    expect(f.nodes.map((x) => [x.id, x.label])).toEqual([
      ['haushalt', 'Person A'],
      ['quelle:1', 'Arbeitgeber Beispiel GmbH'],
      ['quelle:2', 'Nebenjob Beispiel'],
      ['gruppe:1', 'Alltag'],
      ['topf:essen', 'Lebensmittel'],
      ['gruppe:2', 'Wohnen'],
      ['topf:miete', 'Miete'],
      ['topf:depot', 'Investieren'],
      ['rest:nicht_zugeordnet', 'Noch nicht zugeordnet'],
      ['rest:uebrig', 'Übrig'],
    ])
    const value = (s: string, t: string) =>
      f.links.find((l) => l.source === s && l.target === t)?.valueCents
    expect(value('haushalt', 'gruppe:1')).toBe(39_000)
    expect(value('gruppe:1', 'topf:essen')).toBe(39_000)
    expect(value('haushalt', 'topf:depot')).toBe(30_000)
    expect(value('haushalt', 'rest:uebrig')).toBe(320_000 - 164_000)
    const into = f.links
      .filter((l) => l.target === 'haushalt')
      .reduce((s, l) => s + l.valueCents, 0)
    const out = f.links.filter((l) => l.source === 'haushalt').reduce((s, l) => s + l.valueCents, 0)
    expect(into).toBe(out)
  })

  it('fasst kleine Quellen zusammen und gleicht Mehrausgaben aus Erspartem aus', () => {
    const data = Array.from({ length: 8 }, (_, i) =>
      tx('2026-01-01', 1_000 * (8 - i), 'einnahme', { counterparty: `Quelle ${i + 1}` }),
    )
    data.push(tx('2026-01-02', -100_000, 'essen'))
    data.push(tx('2026-01-03', 5_000, 'kfz'))
    const f = flow(data, pots, 'H', '2026-01', '2026-01')
    const sources = f.nodes.filter((x) => x.kind === 'quelle').map((x) => x.label)
    expect(sources).toEqual([
      'Quelle 1',
      'Quelle 2',
      'Quelle 3',
      'Quelle 4',
      'Quelle 5',
      'Weitere Einnahmen',
      'Erstattungen',
      'Aus Erspartem',
    ])
    expect(f.links.find((l) => l.source === 'quelle:weitere')?.valueCents).toBe(6_000)
    expect(f.links.find((l) => l.source === 'quelle:erspartes')?.valueCents).toBe(
      100_000 - 36_000 - 5_000,
    )
  })
})

describe('Auffälligkeiten', () => {
  const history = ['2026-01', '2026-02', '2026-03'].map((m) => tx(`${m}-10`, -30_000, 'essen'))

  it('meldet Ausgaben deutlich über dem Schnitt, aber nicht bei Rücklagen', () => {
    const data = [...history, tx('2026-04-10', -50_000, 'essen'), tx('2026-04-11', -60_000, 'kfz')]
    const items = anomalies(data, pots, [], '2026-04')
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'ausgaben_hoch',
        potId: 'essen',
        amountCents: 50_000,
        referenceCents: 30_000,
      }),
    ])
    expect(items[0]?.title).toBe('Lebensmittel: 500,00 € ausgegeben, sonst im Schnitt 300,00 €.')
  })

  it('braucht genug Historie und einen spürbaren Unterschied', () => {
    // nur zwei Vormonate
    expect(
      anomalies([...history.slice(1), tx('2026-04-10', -90_000, 'essen')], pots, [], '2026-04'),
    ).toEqual([])
    // unter dem Faktor
    expect(
      anomalies([...history, tx('2026-04-10', -44_000, 'essen')], pots, [], '2026-04'),
    ).toEqual([])
    // dreifach, aber weniger als 50 € mehr
    const small = ['2026-01', '2026-02', '2026-03'].map((m) => tx(`${m}-10`, -1_000, 'essen'))
    expect(anomalies([...small, tx('2026-04-10', -3_000, 'essen')], pots, [], '2026-04')).toEqual(
      [],
    )
  })

  it('meldet neue Abos im Monat ihrer Erkennung und Preiserhöhungen', () => {
    const series: AnalyticsSeries[] = [
      {
        id: 'neu',
        counterparty: 'Streaming Beispiel',
        direction: 'ausgang',
        cadence: 'monatlich',
        typicalAmountCents: -1_299,
        state: 'aktiv',
      },
      {
        id: 'alt',
        counterparty: 'Fitness Beispiel',
        direction: 'ausgang',
        cadence: 'monatlich',
        typicalAmountCents: -3_000,
        state: 'aktiv',
      },
      {
        id: 'gleich',
        counterparty: 'Strom Beispiel',
        direction: 'ausgang',
        cadence: 'monatlich',
        typicalAmountCents: -8_000,
        state: 'aktiv',
      },
      {
        id: 'jahr',
        counterparty: 'Versicherung Beispiel',
        direction: 'ausgang',
        cadence: 'jaehrlich',
        typicalAmountCents: -24_000,
        state: 'aktiv',
      },
    ]
    const r = (id: string, date: string, cents: number) =>
      tx(date, cents, null, { recurringSeriesId: id })
    const data = [
      ...['2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15'].map((d) => r('neu', d, -1_299)),
      ...['2026-01-01', '2026-02-01', '2026-03-01'].map((d) => r('alt', d, -3_000)),
      r('alt', '2026-04-01', -3_500),
      ...['2026-01-01', '2026-02-01', '2026-03-01'].map((d) => r('gleich', d, -8_000)),
      r('gleich', '2026-04-01', -8_050),
      r('jahr', '2025-04-20', -24_000),
      r('jahr', '2026-04-20', -24_000),
    ]
    const items = anomalies(data, pots, series, '2026-04')
    expect(items.map((a) => [a.kind, a.seriesId, a.amountCents, a.referenceCents])).toEqual([
      ['preis_erhoeht', 'alt', 3_500, 3_000],
      ['neues_abo', 'jahr', 24_000, null],
      ['neues_abo', 'neu', 1_299, null],
    ])
    expect(items.find((a) => a.seriesId === 'neu')?.title).toBe(
      'Neu: Streaming Beispiel, 12,99 € im Monat.',
    )
    // „neu“ ist im März mit zwei Buchungen noch nicht erkennbar (dafür „alt“ und „gleich“),
    // im Mai nicht mehr neu
    expect(anomalies(data, pots, series, '2026-03').map((a) => a.seriesId)).toEqual([
      'gleich',
      'alt',
    ])
    expect(anomalies(data, pots, series, '2026-05')).toEqual([])
  })
})

describe('Ziele mit Prognose', () => {
  const goal = { potId: 'rad', name: 'Fahrrad', targetCents: 150_000, targetMonth: '2026-08' }
  const rate = (amount: number) =>
    ['2026-02', '2026-03', '2026-04'].map((month) => ({ month, amountCents: amount }))

  it('rechnet aus der Sparrate den Monat des Erreichens', () => {
    expect(goalForecast(goal, 60_000, rate(20_000), '2026-04')).toEqual({
      potId: 'rad',
      name: 'Fahrrad',
      targetCents: 150_000,
      savedCents: 60_000,
      remainingCents: 90_000,
      progressBp: 4_000,
      targetMonth: '2026-08',
      monthlyRateCents: 20_000,
      projectedMonth: '2026-09',
      requiredMonthlyCents: 22_500,
      status: 'verspaetet',
    })
    expect(goalForecast(goal, 60_000, rate(30_000), '2026-04')).toMatchObject({
      projectedMonth: '2026-07',
      status: 'im_plan',
    })
  })

  it('erkennt erreichte Ziele und fehlende Sparrate', () => {
    expect(goalForecast(goal, 160_000, [], '2026-04')).toMatchObject({
      status: 'erreicht',
      remainingCents: 0,
      progressBp: 10_000,
      requiredMonthlyCents: 0,
    })
    expect(goalForecast({ ...goal, targetMonth: null }, 0, [], '2026-04')).toMatchObject({
      status: 'ohne_sparrate',
      projectedMonth: null,
      requiredMonthlyCents: null,
    })
    // Zielmonat erreicht oder vorbei: der ganze Rest ist sofort nötig
    expect(goalForecast(goal, 100_000, [], '2026-08').requiredMonthlyCents).toBe(50_000)
  })
})

describe('Besitzkosten', () => {
  it('summiert die Nettokosten der verknüpften Töpfe im Zeitraum', () => {
    const data = [
      tx('2025-12-01', -99_999, 'kfz'),
      tx('2026-01-15', -60_000, 'kfz', { recurringSeriesId: 'vers' }),
      tx('2026-02-03', -8_000, 'kfz'),
      tx('2026-02-20', 2_000, 'kfz'),
      tx('2026-02-21', -1_000, 'essen'),
    ]
    expect(assetCosts(data, ['kfz'], '2026-01', '2026-03')).toEqual({
      costCents: 66_000,
      recurringCostCents: 60_000,
      monthlyAverageCents: 22_000,
      pots: [{ potId: 'kfz', costCents: 66_000 }],
    })
  })
})
