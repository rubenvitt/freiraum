// Port von AnalyticsTests.swift (FreiraumKit). Alle Namen und Beträge sind erfunden.
import { describe, expect, it } from 'vitest'
import type { Flow, GoalForecast, Metrics, MonthMetrics } from '../api/client'
import {
  assetRow,
  buildAnalytics,
  goalRow,
  historyRange,
  periodRange,
  periodTitle,
} from './presentation'

const NB = ' '
const m = (month: number, year = 2026) => `${year}-${String(month).padStart(2, '0')}`

type Values = Omit<MonthMetrics, 'month' | 'ageOfMoneyDays'>
const values = (v: Partial<Values> = {}): Values => ({
  incomeCents: 0,
  consumptionCents: 0,
  erstIchCents: 0,
  contributionsCents: 0,
  savedCents: 0,
  savingsRateBp: null,
  fixedCostsCents: 0,
  fixedCostShareBp: null,
  uncategorizedOutCents: 0,
  uncategorizedInCents: 0,
  ...v,
})

const month = (
  mm: number,
  rate: number | null,
  fixed: number | null = 2500,
  age: number | null = null,
) =>
  ({
    month: m(mm),
    ...values({
      incomeCents: rate === null ? 0 : 300_000,
      savedCents: (rate ?? 0) * 30,
      savingsRateBp: rate,
      fixedCostsCents: 75_000,
      fixedCostShareBp: fixed,
    }),
    ageOfMoneyDays: age,
  }) satisfies MonthMetrics

const runway = (r: Partial<Metrics['runway']> = {}): Metrics['runway'] => ({
  cashCents: 0,
  averageMonthlyConsumptionCents: null,
  fixedContributionsCents: 0,
  monthlyOutflowCents: null,
  basedOnMonths: 0,
  months: null,
  ...r,
})

function state(summary: Values, months: MonthMetrics[], rw: Metrics['runway'], to = 11) {
  const summaryMetrics: Metrics = {
    householdId: 'h1',
    from: m(to),
    to: m(to),
    months: months.filter((x) => x.month === m(to)),
    totals: summary,
    runway: rw,
  }
  const history: Metrics = { ...summaryMetrics, from: months[0]?.month ?? m(to), months }
  const flow: Flow = {
    householdId: 'h1',
    from: m(to),
    to: m(to),
    nodes: [],
    links: [],
    inCents: 0,
    outCents: 0,
  }
  return buildAnalytics({
    summary: summaryMetrics,
    history,
    flow,
    anomalies: [],
    goals: [],
    ownership: null,
  })
}

describe('Zeitraum', () => {
  it('beginnt frühestens mit dem Budget', () => {
    expect(periodRange('monat', m(11), null)).toEqual({ from: m(11), to: m(11) })
    expect(periodRange('quartal', m(11), null)).toEqual({ from: m(9), to: m(11) })
    expect(periodRange('jahr', m(11), null)).toEqual({ from: m(12, 2025), to: m(11) })
    expect(periodRange('jahr', m(11), m(10))).toEqual({ from: m(10), to: m(11) })
    expect(periodRange('jahr', m(11), m(11))).toEqual({ from: m(11), to: m(11) })
    // Monat vor dem Budgetbeginn: nur dieser Monat.
    expect(periodRange('quartal', m(8), m(10))).toEqual({ from: m(8), to: m(8) })
    expect(historyRange(m(11), null)).toEqual({ from: m(12, 2025), to: m(11) })
    expect(periodTitle({ from: m(11), to: m(11) })).toBe('November 2026')
    expect(periodTitle({ from: m(9), to: m(11) })).toBe('Sept – Nov 2026')
    expect(periodTitle({ from: m(12, 2025), to: m(11) })).toBe('Dez 2025 – Nov 2026')
  })
})

describe('Kacheln und Verlauf', () => {
  it('Kacheln mit Vergleich', () => {
    const months = [
      month(8, 2200, 2500, 30),
      month(9, 2600, 2500, 33),
      month(10, 2500, 2500, 35),
      month(11, 2800, 2500, 41),
    ]
    const summary = values({
      incomeCents: 735_000,
      savedCents: 205_800,
      savingsRateBp: 2800,
      fixedCostsCents: 197_500,
      fixedCostShareBp: 2687,
    })
    const s = state(summary, months, runway({ cashCents: 1_000_000, months: 7.4 }))
    expect(s.tiles.map((t) => t.id)).toEqual(['sparquote', 'fixkosten', 'runway', 'alter'])
    // Schnitt der Monate davor: (2200 + 2600 + 2500) / 3 = 2433 → „+4 Punkte“
    expect(s.tiles[0]!.value).toBe(`28${NB}%`)
    expect(s.tiles[0]!.detail).toBe('+4 Punkte zum Schnitt davor')
    expect(s.tiles[0]!.tone).toBe('good')
    expect(s.tiles[1]!.value).toBe(`27${NB}%`)
    expect(s.tiles[1]!.detail).toBe(`1.975${NB}€ von 7.350${NB}€`)
    expect(s.tiles[2]!.value).toBe('7,4')
    expect(s.tiles[2]!.unit).toBe('Monate')
    expect(s.tiles[3]!.value).toBe('41')
    expect(s.tiles[3]!.detail).toBe('+6 Tage seit Oktober')
    expect(s.savingsRate.map((p) => p.label)).toEqual(['Aug', 'Sept', 'Okt', 'Nov'])
    expect(s.savingsRate.at(-1)!.isCurrent).toBe(true)
    expect(s.savingsRate[0]!.value).toBe(22)
    expect(s.ageOfMoney.at(-1)!.value).toBe(41)
  })

  it('ohne Historie und ohne Einkommen', () => {
    const summary = values({
      consumptionCents: 5000,
      uncategorizedOutCents: 1200,
      uncategorizedInCents: 800,
    })
    const s = state(summary, [month(11, null, null)], runway())
    expect(s.tiles[0]!.value).toBe('–')
    expect(s.tiles[0]!.detail).toBe('Noch kein Einkommen zugeordnet')
    expect(s.tiles[2]!.value).toBe('–')
    expect(s.tiles[2]!.unit).toBeNull()
    expect(s.tiles[3]!.value).toBe('–')
    expect(s.savingsRate[0]!.value).toBeNull()
    expect(s.flowSummary).toBe('Im Zeitraum ist noch nichts geflossen.')
    expect(
      s.uncategorizedNote?.startsWith(
        `Noch nicht zugeordnet: 8${NB}€ Eingänge und 12${NB}€ Ausgänge.`,
      ),
    ).toBe(true)
  })

  it('Runway mit fester Einzahlung', () => {
    const s = state(
      values(),
      [],
      runway({ cashCents: 500_000, fixedContributionsCents: 60_000, months: 3 }),
    )
    expect(s.tiles[2]!.value).toBe('3')
    expect(s.tiles[2]!.detail).toBe(`ohne Einkommen, mit 600${NB}€ Einzahlung im Monat`)
  })
})

describe('Ziele und Besitz', () => {
  const goal = (g: Partial<GoalForecast>): GoalForecast => ({
    potId: 'p',
    name: 'Ziel',
    targetCents: 0,
    savedCents: 0,
    remainingCents: 0,
    progressBp: 0,
    targetMonth: null,
    monthlyRateCents: 0,
    projectedMonth: null,
    requiredMonthlyCents: null,
    status: 'im_plan',
    ...g,
  })

  it('Ziele', () => {
    const late = goalRow(
      goal({
        potId: 'p1',
        name: 'Haus',
        targetCents: 5_000_000,
        savedCents: 1_000_000,
        remainingCents: 4_000_000,
        progressBp: 2000,
        targetMonth: m(12, 2027),
        monthlyRateCents: 100_000,
        projectedMonth: m(3, 2030),
        requiredMonthlyCents: 307_693,
        status: 'verspaetet',
      }),
    )
    expect(late.amount).toBe(`10.000${NB}€ von 50.000${NB}€`)
    expect(late.progress).toBe(0.2)
    expect(late.detail).toBe(
      `Bei heutiger Sparrate erst im März 2030 (Ziel: Dezember 2027). Nötig: 3.076,93${NB}€ im Monat.`,
    )
    expect(late.onTrack).toBe(false)
    const none = goalRow(goal({ targetCents: 100_000, status: 'ohne_sparrate' }))
    expect(none.detail).toBe('Noch keine Sparrate in den letzten 3 Monaten.')
    const done = goalRow(
      goal({ targetCents: 100_000, savedCents: 120_000, progressBp: 12_000, status: 'erreicht' }),
    )
    expect(done.progress).toBe(1)
    expect(done.detail).toBe('Erreicht.')
    const onPlan = goalRow(goal({ projectedMonth: m(4, 2027), targetMonth: m(6, 2027) }))
    expect(onPlan.detail).toBe('Bei heutiger Sparrate erreicht im April 2027 (Ziel: Juni 2027).')
    expect(onPlan.onTrack).toBe(true)
  })

  it('Besitz', () => {
    const car = assetRow({
      assetId: 'x1',
      name: 'Auto',
      valueCents: 800_000,
      costCents: 240_000,
      recurringCostCents: 90_000,
      monthlyAverageCents: 20_000,
      annualCostOfValueBp: 3000,
      classification: 'verbindlichkeit',
      pots: [{ potId: 'p4', name: 'Sprit', costCents: 150_000 }],
    })
    expect(car.cost).toBe(`2.400${NB}€`)
    expect(car.detail).toBe(`Ø 200${NB}€ im Monat · davon wiederkehrend 900${NB}€`)
    expect(car.classification).toBe('Verbindlichkeit')
    expect(car.isLiability).toBe(true)
    expect(car.valueNote).toBe(`Wert 8.000${NB}€, kostet 30${NB}% davon im Jahr`)
    expect(car.pots).toEqual([`Sprit 1.500${NB}€`])
  })
})
