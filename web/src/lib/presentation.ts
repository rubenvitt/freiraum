// Aufbereitung der Auswertungen für die Anzeige, Port von AnalyticsPresentation.swift (FreiraumKit).
// Alle Kennzahlen kommen vom Server; hier entstehen nur Texte und Vergleiche zwischen seinen Werten.
import type {
  Anomaly,
  AssetCosts,
  Flow,
  GoalForecast,
  Metrics,
  OwnershipCosts,
} from '../api/client'
import { MINUS, money, points, ratio, ratioValue } from './money'
import { compare, monthName, monthShort, monthTitle, previous, type YearMonth } from './month'

export type Period = 'monat' | 'quartal' | 'jahr'
export const PERIODS: Period[] = ['monat', 'quartal', 'jahr']
export const PERIOD_TITLES: Record<Period, string> = {
  monat: 'Monat',
  quartal: 'Quartal',
  jahr: 'Jahr',
}
const PERIOD_LENGTH: Record<Period, number> = { monat: 1, quartal: 3, jahr: 12 }

export type Range = { from: YearMonth; to: YearMonth }

function rangeOf(months: number, to: YearMonth, budgetStart: YearMonth | null): Range {
  let from = to
  for (let i = 1; i < Math.max(1, months); i++) from = previous(from)
  if (budgetStart && compare(budgetStart, from) > 0) {
    from = compare(budgetStart, to) < 0 ? budgetStart : to
  }
  return { from, to }
}

/** Monate bis einschließlich `to`, frühestens ab dem Budgetbeginn (ADR 0005). */
export const periodRange = (period: Period, to: YearMonth, budgetStart: YearMonth | null): Range =>
  rangeOf(PERIOD_LENGTH[period], to, budgetStart)

/** Verlauf für Diagramme: bis zu 12 Monate bis `to`, ab dem Budgetbeginn. */
export const historyRange = (to: YearMonth, budgetStart: YearMonth | null): Range =>
  rangeOf(12, to, budgetStart)

/** „November 2026“, „Sept – Nov 2026“, „Dez 2025 – Nov 2026“. */
export function periodTitle({ from, to }: Range): string {
  if (from === to) return monthTitle(to)
  const yearOf = (m: YearMonth) => m.slice(0, 4)
  if (yearOf(from) === yearOf(to)) return `${monthShort(from)} – ${monthShort(to)} ${yearOf(to)}`
  return `${monthShort(from)} ${yearOf(from)} – ${monthShort(to)} ${yearOf(to)}`
}

export type Tone = 'neutral' | 'good' | 'warning'

export type MetricTile = {
  id: 'sparquote' | 'fixkosten' | 'runway' | 'alter'
  title: string
  value: string
  /** kleiner hinter dem Wert, z. B. „Monate“ */
  unit: string | null
  detail: string
  tone: Tone
}

export type TrendPoint = {
  month: YearMonth
  /** „Nov“ */
  label: string
  /** null = kein Wert (z. B. ohne Einkommen) */
  value: number | null
  /** Beschriftung, z. B. „28 %“ */
  text: string
  isCurrent: boolean
}

export type AnomalyRow = { id: string; title: string; badge: string }

export type GoalRow = {
  id: string
  name: string
  amount: string
  /** 0…1 */
  progress: number
  detail: string
  onTrack: boolean
}

export type AssetRow = {
  id: string
  name: string
  cost: string
  detail: string
  classification: string
  isLiability: boolean
  valueNote: string | null
  pots: string[]
}

export type AnalyticsView = {
  range: Range
  periodTitle: string
  tiles: MetricTile[]
  savingsRate: TrendPoint[]
  fixedCostShare: TrendPoint[]
  ageOfMoney: TrendPoint[]
  anomalies: AnomalyRow[]
  goals: GoalRow[]
  assets: AssetRow[]
  /** „Besitz kostet 2.345 € im Zeitraum, 14 % des Konsums.“; null ohne Besitz */
  assetSummary: string | null
  /** „7.350 € kamen herein, 6.900 € flossen hinaus.“ */
  flowSummary: string
  /** Hinweis, wenn Ein- oder Ausgänge noch nicht zugeordnet sind */
  uncategorizedNote: string | null
}

const BADGES: Record<Anomaly['kind'], string> = {
  ausgaben_hoch: 'Ausgaben hoch',
  neues_abo: 'Neues Abo',
  preis_erhoeht: 'Preis erhöht',
}

export const anomalyRow = (a: Anomaly, index: number): AnomalyRow => ({
  id: `${a.kind}:${a.potId ?? a.seriesId ?? ''}#${index}`,
  title: a.title,
  badge: BADGES[a.kind],
})

export function goalRow(g: GoalForecast): GoalRow {
  const target = g.targetMonth ? ` (Ziel: ${monthTitle(g.targetMonth)})` : ''
  const needed =
    g.requiredMonthlyCents !== null ? `Nötig: ${money(g.requiredMonthlyCents)} im Monat.` : null
  let detail: string
  let onTrack: boolean
  switch (g.status) {
    case 'erreicht':
      detail = 'Erreicht.'
      onTrack = true
      break
    case 'im_plan': {
      const when = g.projectedMonth
        ? `Bei heutiger Sparrate erreicht im ${monthTitle(g.projectedMonth)}`
        : 'Im Plan'
      detail = `${when}${target}.`
      onTrack = true
      break
    }
    case 'verspaetet': {
      const when = g.projectedMonth
        ? `Bei heutiger Sparrate erst im ${monthTitle(g.projectedMonth)}`
        : 'Verspätet'
      detail = [`${when}${target}.`, needed].filter(Boolean).join(' ')
      onTrack = false
      break
    }
    case 'ohne_sparrate':
      detail = ['Noch keine Sparrate in den letzten 3 Monaten.', needed].filter(Boolean).join(' ')
      onTrack = false
      break
  }
  return {
    id: g.potId,
    name: g.name,
    amount: `${money(g.savedCents)} von ${money(g.targetCents)}`,
    progress: Math.min(1, Math.max(0, g.progressBp / 10_000)),
    detail,
    onTrack,
  }
}

const CLASSIFICATIONS: Record<AssetCosts['classification'], string> = {
  verbindlichkeit: 'Verbindlichkeit',
  vermoegenswert: 'Vermögenswert',
  neutral: 'Neutral',
}

export function assetRow(a: AssetCosts): AssetRow {
  const parts = [`Ø ${money(a.monthlyAverageCents)} im Monat`]
  if (a.recurringCostCents !== 0) parts.push(`davon wiederkehrend ${money(a.recurringCostCents)}`)
  let valueNote: string | null = null
  if (a.valueCents !== null && a.annualCostOfValueBp !== null) {
    valueNote =
      a.annualCostOfValueBp >= 0
        ? `Wert ${money(a.valueCents)}, kostet ${ratio(a.annualCostOfValueBp)} davon im Jahr`
        : `Wert ${money(a.valueCents)}, bringt ${ratio(-a.annualCostOfValueBp)} davon im Jahr`
  } else if (a.valueCents !== null) {
    valueNote = `Wert ${money(a.valueCents)}`
  }
  return {
    id: a.assetId,
    name: a.name,
    cost: money(a.costCents),
    detail: parts.join(' · '),
    classification: CLASSIFICATIONS[a.classification],
    isLiability: a.classification === 'verbindlichkeit',
    valueNote,
    pots: a.pots.map((p) => `${p.name} ${money(p.costCents)}`),
  }
}

export function buildAnalytics(input: {
  summary: Metrics
  history: Metrics
  /** Geldfluss des Haushalts (auch wenn der Sankey den Fluss über die Haushalte zeigt) */
  flow: Flow
  anomalies: Anomaly[]
  goals: GoalForecast[]
  ownership: OwnershipCosts | null
}): AnalyticsView {
  const { summary, history, flow } = input
  const range = { from: summary.from, to: summary.to }
  const totals = summary.totals

  // Vergleich mit den Monaten vor dem Zeitraum (nur solche mit Wert).
  const rates = history.months
    .filter((m) => compare(m.month, summary.from) < 0)
    .map((m) => m.savingsRateBp)
    .filter((r): r is number => r !== null)
  let rateDetail: string
  let rateTone: Tone = 'neutral'
  if (totals.savingsRateBp !== null && rates.length > 0) {
    const average = Math.trunc(rates.reduce((a, b) => a + b, 0) / rates.length)
    rateDetail = `${points(totals.savingsRateBp - average)} zum Schnitt davor`
    rateTone = totals.savingsRateBp >= average ? 'good' : 'warning'
  } else if (totals.incomeCents > 0) {
    rateDetail = `${money(totals.savedCents)} von ${money(totals.incomeCents)} gespart`
  } else {
    rateDetail = 'Noch kein Einkommen zugeordnet'
  }

  const fixedDetail =
    totals.incomeCents > 0
      ? `${money(totals.fixedCostsCents)} von ${money(totals.incomeCents)}`
      : 'Noch kein Einkommen zugeordnet'

  const runway = summary.runway
  let runwayValue = '–'
  let runwayDetail = 'Braucht einen abgeschlossenen Monat mit Ausgaben'
  if (runway.months !== null) {
    const tenths = Math.round(runway.months * 10)
    runwayValue = tenths % 10 === 0 ? `${tenths / 10}` : `${Math.trunc(tenths / 10)},${tenths % 10}`
    runwayDetail =
      runway.fixedContributionsCents > 0
        ? `ohne Einkommen, mit ${money(runway.fixedContributionsCents)} Einzahlung im Monat`
        : 'ohne Einkommen, bei heutigen Ausgaben'
  }

  const shown = history.months.filter((m) => compare(m.month, summary.to) <= 0)
  const age = shown.at(-1)?.ageOfMoneyDays ?? null
  let ageDetail = 'Wie lange ausgegebenes Geld schon da war'
  let ageTone: Tone = 'neutral'
  const prior = shown.at(-2)
  if (age !== null && prior && prior.ageOfMoneyDays !== null) {
    const delta = age - prior.ageOfMoneyDays
    const sign = delta > 0 ? '+' : delta < 0 ? MINUS : '±'
    const n = Math.abs(delta)
    ageDetail = `${sign}${n} ${n === 1 ? 'Tag' : 'Tage'} seit ${monthName(prior.month)}`
    ageTone = delta >= 0 ? 'good' : 'warning'
  }

  const tiles: MetricTile[] = [
    {
      id: 'sparquote',
      title: 'Sparquote',
      value: ratio(totals.savingsRateBp),
      unit: null,
      detail: rateDetail,
      tone: rateTone,
    },
    {
      id: 'fixkosten',
      title: 'Fixkosten am Einkommen',
      value: ratio(totals.fixedCostShareBp),
      unit: null,
      detail: fixedDetail,
      tone: 'neutral',
    },
    {
      id: 'runway',
      title: 'Runway',
      value: runwayValue,
      unit: runway.months === null ? null : 'Monate',
      detail: runwayDetail,
      tone: 'neutral',
    },
    {
      id: 'alter',
      title: 'Alter des Geldes',
      value: age === null ? '–' : String(age),
      unit: age === null ? null : age === 1 ? 'Tag' : 'Tage',
      detail: ageDetail,
      tone: ageTone,
    },
  ]

  const last = shown.at(-1)?.month
  type Shown = (typeof shown)[number]
  const trend = (value: (m: Shown) => number | null, text: (m: Shown) => string) =>
    shown.map<TrendPoint>((m) => ({
      month: m.month,
      label: monthShort(m.month),
      value: value(m),
      text: text(m),
      isCurrent: m.month === last,
    }))

  const ownership = input.ownership
  let assetSummary: string | null = null
  if (ownership && ownership.items.length > 0) {
    assetSummary = `Besitz kostet ${money(ownership.totalCostCents)} im Zeitraum`
    if (ownership.shareOfConsumptionBp !== null) {
      assetSummary += `, ${ratio(ownership.shareOfConsumptionBp)} des Konsums`
    }
    assetSummary += '.'
  }

  const notes: string[] = []
  if (totals.uncategorizedInCents > 0) notes.push(`${money(totals.uncategorizedInCents)} Eingänge`)
  if (totals.uncategorizedOutCents > 0)
    notes.push(`${money(totals.uncategorizedOutCents)} Ausgänge`)

  return {
    range,
    periodTitle: periodTitle(range),
    tiles,
    savingsRate: trend(
      (m) => (m.savingsRateBp === null ? null : ratioValue(m.savingsRateBp)),
      (m) => ratio(m.savingsRateBp),
    ),
    fixedCostShare: trend(
      (m) => (m.fixedCostShareBp === null ? null : ratioValue(m.fixedCostShareBp)),
      (m) => ratio(m.fixedCostShareBp),
    ),
    ageOfMoney: trend(
      (m) => m.ageOfMoneyDays,
      (m) => (m.ageOfMoneyDays === null ? '–' : `${m.ageOfMoneyDays} T`),
    ),
    anomalies: input.anomalies.map(anomalyRow),
    goals: input.goals.map(goalRow),
    assets: ownership?.items.map(assetRow) ?? [],
    assetSummary,
    flowSummary:
      flow.links.length === 0
        ? 'Im Zeitraum ist noch nichts geflossen.'
        : `${money(flow.inCents)} kamen herein, ${money(flow.outCents)} flossen hinaus.`,
    uncategorizedNote:
      notes.length === 0
        ? null
        : `Noch nicht zugeordnet: ${notes.join(' und ')}. Eingänge zählen erst als Einkommen, wenn sie zugeordnet sind.`,
  }
}
