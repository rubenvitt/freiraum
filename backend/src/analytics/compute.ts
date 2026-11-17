/**
 * Auswertungen eines Haushalts, als reine Funktionen über Buchungen und Aufteilungen.
 * Rechenregeln und Begründungen: ADR 0005.
 *
 * Grundbegriffe:
 * - **Einkommen** = Einnahme-Aufteilungen (zugeordnet, nicht bloß jeder Eingang).
 * - **Konsum** = Ausgaben aus Töpfen außer Erst-ich, abzüglich Erstattungen, plus noch nicht
 *   zugeordnete Ausgänge (vorsichtig gerechnet: was nicht zugeordnet ist, gilt als ausgegeben).
 * - **Erst ich** = Ausgaben aus Erst-ich-Töpfen (Überweisung aufs Depot o. Ä.). Das ist Sparen,
 *   kein Konsum.
 * - **Einzahlungen** ins Gemeinsame (privates Konto) verlassen den Haushalt: kein Konsum aus
 *   eigenen Töpfen, aber auch nicht gespart. Auf dem gemeinsamen Konto sind sie Einkommen.
 * - **Gespart** = Einkommen − Konsum − Einzahlungen. Die Sparquote ist Gespart ÷ Einkommen.
 * - **Umbuchungen** zwischen eigenen Konten zählen nirgends, ebenso **Ausgleich** und privat
 *   bezahlte Ausgaben in Töpfen eines anderen (des gemeinsamen) Haushalts: Das ist eine Forderung
 *   ans Gemeinsame, kein eigener Konsum (ADR 0006).
 */

import type { PotKind } from '../budget/compute.js'
import { addMonthsTo, type Month, maxMonth, monthOf, monthsBetween } from '../budget/months.js'
import { addDays, daysBetween, type IsoDate } from '../ledger/dates.js'
import { type Cadence, MIN_OCCURRENCES } from '../ledger/recurring.js'

export type SplitKind = 'topf' | 'einnahme' | 'umbuchung' | 'einzahlung' | 'ausgleich'

export interface AnalyticsSplit {
  kind: SplitKind
  potId: string | null
  amountCents: number
}

export interface AnalyticsTransaction {
  id: string
  bookingDate: IsoDate
  amountCents: number
  /** Gegenpartei für die Anzeige (Name, sonst IBAN), null ohne Angaben */
  counterparty: string | null
  recurringSeriesId: string | null
  /** leer = noch nicht zugeordnet */
  splits: AnalyticsSplit[]
}

export interface AnalyticsPot {
  id: string
  name: string
  kind: PotKind
  groupName: string | null
  archived: boolean
}

// --- Einordnung einer Buchung ---------------------------------------------------

export interface Classified {
  incomeCents: number
  /** positiv = ausgegeben */
  consumptionCents: number
  erstIchCents: number
  /** Einzahlungen ins Gemeinsame vom privaten Konto, positiv = abgeflossen */
  contributionsCents: number
  fixedCostsCents: number
  uncategorizedOutCents: number
  uncategorizedInCents: number
}

const ZERO: Classified = {
  incomeCents: 0,
  consumptionCents: 0,
  erstIchCents: 0,
  contributionsCents: 0,
  fixedCostsCents: 0,
  uncategorizedOutCents: 0,
  uncategorizedInCents: 0,
}

export function classify(tx: AnalyticsTransaction, potKinds: Map<string, PotKind>): Classified {
  const result = { ...ZERO }
  const recurringOut = tx.recurringSeriesId !== null && tx.amountCents < 0
  if (tx.splits.length === 0) {
    if (tx.amountCents < 0) {
      result.uncategorizedOutCents = -tx.amountCents
      result.consumptionCents = -tx.amountCents
      if (recurringOut) result.fixedCostsCents = -tx.amountCents
    } else {
      result.uncategorizedInCents = tx.amountCents
    }
    return result
  }
  let consumption = 0
  for (const s of tx.splits) {
    if (s.kind === 'einnahme') result.incomeCents += s.amountCents
    else if (s.kind === 'einzahlung') {
      // Die Richtung ist je Kontoart fest: privat Ausgang, gemeinsam Eingang (ADR 0006).
      if (s.amountCents > 0) result.incomeCents += s.amountCents
      else result.contributionsCents -= s.amountCents
    } else if (s.kind === 'topf' && s.potId !== null) {
      const kind = potKinds.get(s.potId)
      // Topf eines anderen Haushalts: Forderung ans Gemeinsame, kein eigener Konsum.
      if (kind === undefined) continue
      if (kind === 'erst_ich') result.erstIchCents -= s.amountCents
      else consumption -= s.amountCents
    }
  }
  result.consumptionCents = consumption
  // Fixkosten: der Konsum-Anteil einer wiederkehrenden Ausgabe (ein Sparplan ist keine Fixkost).
  if (recurringOut && consumption > 0) result.fixedCostsCents = consumption
  return result
}

const add = (a: Classified, b: Classified): Classified => ({
  incomeCents: a.incomeCents + b.incomeCents,
  consumptionCents: a.consumptionCents + b.consumptionCents,
  erstIchCents: a.erstIchCents + b.erstIchCents,
  contributionsCents: a.contributionsCents + b.contributionsCents,
  fixedCostsCents: a.fixedCostsCents + b.fixedCostsCents,
  uncategorizedOutCents: a.uncategorizedOutCents + b.uncategorizedOutCents,
  uncategorizedInCents: a.uncategorizedInCents + b.uncategorizedInCents,
})

/** Anteil in Basispunkten (10 000 = 100 %), null ohne positive Basis. */
export function shareBp(part: number, base: number): number | null {
  return base > 0 ? Math.round((part * 10_000) / base) : null
}

// --- Alter des Geldes -------------------------------------------------------------

export interface AgedOutflow {
  date: IsoDate
  ageDays: number
}

/**
 * Alter jedes Ausgangs: Eingänge bilden eine Warteschlange (älteste zuerst), jeder Ausgang
 * verbraucht von vorn. Das Alter ist der mit dem Betrag gewichtete Abstand in Tagen. Ausgänge,
 * für die kein bekannter Eingang mehr da ist (Geld aus der Zeit vor dem ersten Import), bekommen
 * kein Alter. Umbuchungen zählen nicht.
 */
export function agedOutflows(transactions: AnalyticsTransaction[]): AgedOutflow[] {
  const events = transactions
    .map((tx) => ({
      date: tx.bookingDate,
      amount:
        tx.splits.length === 0
          ? tx.amountCents
          : tx.splits.filter((s) => s.kind !== 'umbuchung').reduce((n, s) => n + s.amountCents, 0),
    }))
    .filter((e) => e.amount !== 0)
    // am selben Tag erst Eingänge, dann Ausgänge
    .sort((a, b) => (a.date === b.date ? b.amount - a.amount : a.date < b.date ? -1 : 1))

  const lots: { date: IsoDate; left: number }[] = []
  let head = 0
  const result: AgedOutflow[] = []
  for (const e of events) {
    if (e.amount > 0) {
      lots.push({ date: e.date, left: e.amount })
      continue
    }
    let need = -e.amount
    let weighted = 0
    let covered = 0
    while (need > 0 && head < lots.length) {
      const lot = lots[head] as { date: IsoDate; left: number }
      const take = Math.min(lot.left, need)
      weighted += take * daysBetween(lot.date, e.date)
      covered += take
      lot.left -= take
      need -= take
      if (lot.left === 0) head++
    }
    if (covered > 0) result.push({ date: e.date, ageDays: weighted / covered })
  }
  return result
}

/** Alter des Geldes zum Stichtag: Durchschnitt der letzten 10 Ausgänge bis dahin, in Tagen. */
export function ageOfMoneyAt(outflows: AgedOutflow[], date: IsoDate): number | null {
  const upTo = outflows.filter((o) => o.date <= date).slice(-10)
  if (upTo.length === 0) return null
  return Math.round(upTo.reduce((n, o) => n + o.ageDays, 0) / upTo.length)
}

const lastDayOf = (month: Month): IsoDate => addDays(`${addMonthsTo(month, 1)}-01`, -1)

// --- Kennzahlen je Monat ----------------------------------------------------------

export interface MonthMetrics extends Classified {
  month: Month
  savedCents: number
  savingsRateBp: number | null
  fixedCostShareBp: number | null
  ageOfMoneyDays: number | null
}

export interface MetricsTotals extends Classified {
  savedCents: number
  savingsRateBp: number | null
  fixedCostShareBp: number | null
}

export function monthRange(from: Month, to: Month): Month[] {
  const months: Month[] = []
  for (let m = from; m <= to; m = addMonthsTo(m, 1)) months.push(m)
  return months
}

function byMonth(
  transactions: AnalyticsTransaction[],
  potKinds: Map<string, PotKind>,
): Map<Month, Classified> {
  const map = new Map<Month, Classified>()
  for (const tx of transactions) {
    const m = monthOf(tx.bookingDate)
    map.set(m, add(map.get(m) ?? ZERO, classify(tx, potKinds)))
  }
  return map
}

const withRates = (c: Classified) => {
  const savedCents = c.incomeCents - c.consumptionCents - c.contributionsCents
  return {
    ...c,
    savedCents,
    savingsRateBp: shareBp(savedCents, c.incomeCents),
    fixedCostShareBp: shareBp(c.fixedCostsCents, c.incomeCents),
  }
}

export function monthlyMetrics(
  transactions: AnalyticsTransaction[],
  pots: AnalyticsPot[],
  from: Month,
  to: Month,
  asOf: IsoDate,
): { months: MonthMetrics[]; totals: MetricsTotals } {
  const potKinds = new Map(pots.map((p) => [p.id, p.kind]))
  const perMonth = byMonth(transactions, potKinds)
  const aged = agedOutflows(transactions)
  let total = ZERO
  const months = monthRange(from, to).map((month) => {
    const c = perMonth.get(month) ?? ZERO
    total = add(total, c)
    const end = lastDayOf(month)
    return {
      month,
      ...withRates(c),
      ageOfMoneyDays: month > monthOf(asOf) ? null : ageOfMoneyAt(aged, end < asOf ? end : asOf),
    }
  })
  return { months, totals: withRates(total) }
}

// --- Runway ------------------------------------------------------------------------

export interface Runway {
  /** Geld des Haushalts laut Budget (Noch ohne Aufgabe + alle Töpfe) */
  cashCents: number
  /** Durchschnittlicher Konsum der letzten (bis zu) 6 abgeschlossenen Monate */
  averageMonthlyConsumptionCents: number | null
  /**
   * Feste Einzahlungen ins Gemeinsame, die jetzt gelten: Sie laufen auch ohne Einkommen weiter.
   * Ein Anteil vom Netto fällt ohne Einkommen weg und zählt nicht (ADR 0005).
   */
  fixedContributionsCents: number
  /** Laufender Abfluss je Monat = Konsum + feste Einzahlungen; null ohne Historie */
  monthlyOutflowCents: number | null
  basedOnMonths: number
  /** Monate ohne Einkommen bei diesem Abfluss, eine Nachkommastelle */
  months: number | null
}

export function runway(
  transactions: AnalyticsTransaction[],
  pots: AnalyticsPot[],
  cashCents: number,
  asOf: IsoDate,
  fixedContributionsCents = 0,
): Runway {
  const potKinds = new Map(pots.map((p) => [p.id, p.kind]))
  const perMonth = byMonth(transactions, potKinds)
  const current = monthOf(asOf)
  const first = [...perMonth.keys()].sort()[0]
  const months =
    first === undefined || first >= current
      ? []
      : monthRange(maxMonth(first, addMonthsTo(current, -6)), addMonthsTo(current, -1))
  if (months.length === 0) {
    // Ohne Konsum-Historie wäre ein Runway nur aus den Einzahlungen geschönt: lieber keiner.
    return {
      cashCents,
      averageMonthlyConsumptionCents: null,
      fixedContributionsCents,
      monthlyOutflowCents: null,
      basedOnMonths: 0,
      months: null,
    }
  }
  const sum = months.reduce((n, m) => n + (perMonth.get(m)?.consumptionCents ?? 0), 0)
  const average = Math.round(sum / months.length)
  const outflow = average + fixedContributionsCents
  return {
    cashCents,
    averageMonthlyConsumptionCents: average,
    fixedContributionsCents,
    monthlyOutflowCents: outflow,
    basedOnMonths: months.length,
    months: outflow > 0 ? Math.max(0, Math.round((cashCents / outflow) * 10) / 10) : null,
  }
}

// --- Geldfluss (Sankey) -------------------------------------------------------------

export type FlowNodeKind = 'quelle' | 'haushalt' | 'gruppe' | 'topf' | 'rest'

export interface FlowNode {
  id: string
  label: string
  kind: FlowNodeKind
  potId: string | null
  potKind: PotKind | null
}

export interface FlowLink {
  source: string
  target: string
  valueCents: number
}

export interface Flow {
  nodes: FlowNode[]
  links: FlowLink[]
  inCents: number
  outCents: number
}

/** Höchstzahl einzeln gezeigter Einnahmequellen; der Rest wird zusammengefasst. */
const MAX_SOURCES = 6
const HOUSEHOLD = 'haushalt'

/**
 * Geldfluss im Zeitraum: Einnahmequellen → Haushalt → Gruppen → Töpfe. Die Mitte ist
 * ausgeglichen: Fließt mehr hinaus als hinein, kommt der Rest „aus Erspartem“; fließt weniger
 * hinaus, bleibt er „übrig“. Töpfe mit mehr Erstattungen als Ausgaben erscheinen als Quelle.
 */
export function flow(
  transactions: AnalyticsTransaction[],
  pots: AnalyticsPot[],
  householdName: string,
  from: Month,
  to: Month,
): Flow {
  const inRange = transactions.filter((tx) => {
    const m = monthOf(tx.bookingDate)
    return m >= from && m <= to
  })
  const income = new Map<string, number>()
  const potNet = new Map<string, number>()
  let uncategorizedIn = 0
  let uncategorizedOut = 0
  for (const tx of inRange) {
    if (tx.splits.length === 0) {
      if (tx.amountCents < 0) uncategorizedOut -= tx.amountCents
      else uncategorizedIn += tx.amountCents
      continue
    }
    for (const s of tx.splits) {
      if (s.kind === 'einnahme') {
        const label = tx.counterparty ?? 'Ohne Angabe'
        income.set(label, (income.get(label) ?? 0) + s.amountCents)
      } else if (s.kind === 'topf' && s.potId !== null) {
        potNet.set(s.potId, (potNet.get(s.potId) ?? 0) + s.amountCents)
      }
    }
  }

  const nodes: FlowNode[] = []
  const links: FlowLink[] = []
  const node = (id: string, label: string, kind: FlowNodeKind, pot?: AnalyticsPot) => {
    nodes.push({ id, label, kind, potId: pot?.id ?? null, potKind: pot?.kind ?? null })
  }
  const link = (source: string, target: string, valueCents: number) => {
    if (valueCents > 0) links.push({ source, target, valueCents })
  }

  // Quellen
  const sources = [...income.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const shown = sources.length > MAX_SOURCES ? sources.slice(0, MAX_SOURCES - 1) : sources
  const rest = sources.slice(shown.length).reduce((n, [, v]) => n + v, 0)
  shown.forEach(([label, value], i) => {
    node(`quelle:${i + 1}`, label, 'quelle')
    link(`quelle:${i + 1}`, HOUSEHOLD, value)
  })
  if (rest > 0) {
    node('quelle:weitere', 'Weitere Einnahmen', 'quelle')
    link('quelle:weitere', HOUSEHOLD, rest)
  }
  const refunds = [...potNet.values()].filter((v) => v > 0).reduce((n, v) => n + v, 0)
  if (refunds > 0) {
    node('quelle:erstattungen', 'Erstattungen', 'quelle')
    link('quelle:erstattungen', HOUSEHOLD, refunds)
  }
  if (uncategorizedIn > 0) {
    node('quelle:nicht_zugeordnet', 'Nicht zugeordnete Eingänge', 'quelle')
    link('quelle:nicht_zugeordnet', HOUSEHOLD, uncategorizedIn)
  }

  // Ziele: Töpfe, nach Gruppe geordnet (Reihenfolge wie im Budget)
  const groups = new Map<string, { pot: AnalyticsPot; value: number }[]>()
  const ungrouped: { pot: AnalyticsPot; value: number }[] = []
  for (const pot of pots) {
    const value = -(potNet.get(pot.id) ?? 0)
    if (value <= 0) continue
    if (pot.groupName === null) ungrouped.push({ pot, value })
    else groups.set(pot.groupName, [...(groups.get(pot.groupName) ?? []), { pot, value }])
  }
  let groupIndex = 0
  for (const [name, members] of groups) {
    const id = `gruppe:${++groupIndex}`
    node(id, name, 'gruppe')
    link(
      HOUSEHOLD,
      id,
      members.reduce((n, m) => n + m.value, 0),
    )
    for (const m of members) {
      node(`topf:${m.pot.id}`, m.pot.name, 'topf', m.pot)
      link(id, `topf:${m.pot.id}`, m.value)
    }
  }
  for (const m of ungrouped) {
    node(`topf:${m.pot.id}`, m.pot.name, 'topf', m.pot)
    link(HOUSEHOLD, `topf:${m.pot.id}`, m.value)
  }
  if (uncategorizedOut > 0) {
    node('rest:nicht_zugeordnet', 'Noch nicht zugeordnet', 'rest')
    link(HOUSEHOLD, 'rest:nicht_zugeordnet', uncategorizedOut)
  }

  const inflow = links.filter((l) => l.target === HOUSEHOLD).reduce((n, l) => n + l.valueCents, 0)
  const outflow = links.filter((l) => l.source === HOUSEHOLD).reduce((n, l) => n + l.valueCents, 0)
  if (outflow > inflow) {
    node('quelle:erspartes', 'Aus Erspartem', 'quelle')
    link('quelle:erspartes', HOUSEHOLD, outflow - inflow)
  } else if (inflow > outflow) {
    node('rest:uebrig', 'Übrig', 'rest')
    link(HOUSEHOLD, 'rest:uebrig', inflow - outflow)
  }
  nodes.unshift({
    id: HOUSEHOLD,
    label: householdName,
    kind: 'haushalt',
    potId: null,
    potKind: null,
  })
  return { nodes, links, inCents: inflow, outCents: outflow }
}

// --- Auffälligkeiten --------------------------------------------------------------

export interface AnalyticsSeries {
  id: string
  counterparty: string
  direction: 'eingang' | 'ausgang'
  cadence: Cadence
  typicalAmountCents: number
  state: 'aktiv' | 'beendet'
}

export type AnomalyKind = 'ausgaben_hoch' | 'neues_abo' | 'preis_erhoeht'

export interface Anomaly {
  kind: AnomalyKind
  title: string
  potId: string | null
  seriesId: string | null
  /** Betrag im Monat bzw. neuer Betrag (positiv) */
  amountCents: number
  /** Vergleichswert: Durchschnitt bzw. bisheriger Betrag (positiv), null bei neuen Abos */
  referenceCents: number | null
}

/** Schwellen für „Ausgaben deutlich über dem Schnitt“ (ADR 0005). */
export const SPENDING_FACTOR = 1.5
export const SPENDING_MIN_DIFF_CENTS = 5_000
export const SPENDING_HISTORY_MONTHS = 6
export const SPENDING_MIN_HISTORY_MONTHS = 3
/** Preiserhöhung ab diesem Anteil und mindestens 1 €. */
export const PRICE_INCREASE_BP = 300
export const PRICE_INCREASE_MIN_CENTS = 100

const CADENCE_LABEL: Record<Cadence, string> = {
  woechentlich: 'pro Woche',
  zweiwoechentlich: 'alle zwei Wochen',
  monatlich: 'im Monat',
  quartalsweise: 'im Quartal',
  halbjaehrlich: 'im Halbjahr',
  jaehrlich: 'im Jahr',
}

const euro = (cents: number) =>
  `${(cents / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`

export function anomalies(
  transactions: AnalyticsTransaction[],
  pots: AnalyticsPot[],
  series: AnalyticsSeries[],
  month: Month,
): Anomaly[] {
  const result: Anomaly[] = []
  const firstMonth = transactions.map((t) => monthOf(t.bookingDate)).sort()[0]

  // 1. Ausgaben eines Topfs deutlich über dem Schnitt der Vormonate
  const spending = new Map<string, number>()
  for (const tx of transactions) {
    for (const s of tx.splits) {
      if (s.kind !== 'topf' || s.potId === null) continue
      const k = `${s.potId}|${monthOf(tx.bookingDate)}`
      spending.set(k, (spending.get(k) ?? 0) - s.amountCents)
    }
  }
  if (firstMonth !== undefined) {
    const history = monthRange(
      addMonthsTo(month, -SPENDING_HISTORY_MONTHS),
      addMonthsTo(month, -1),
    ).filter((m) => m >= firstMonth)
    if (history.length >= SPENDING_MIN_HISTORY_MONTHS) {
      for (const pot of pots) {
        // Rücklagen und Ziele werden geplant unregelmäßig geleert; das ist keine Auffälligkeit.
        if (pot.kind !== 'monatlich') continue
        const now = spending.get(`${pot.id}|${month}`) ?? 0
        const average = Math.round(
          history.reduce((n, m) => n + Math.max(0, spending.get(`${pot.id}|${m}`) ?? 0), 0) /
            history.length,
        )
        if (now >= average * SPENDING_FACTOR && now - average >= SPENDING_MIN_DIFF_CENTS) {
          result.push({
            kind: 'ausgaben_hoch',
            title: `${pot.name}: ${euro(now)} ausgegeben, sonst im Schnitt ${euro(average)}.`,
            potId: pot.id,
            seriesId: null,
            amountCents: now,
            referenceCents: average,
          })
        }
      }
    }
  }

  // 2. Neue Abos und 3. Preiserhöhungen bei laufenden Serien
  const end = lastDayOf(month)
  const bySeries = new Map<string, AnalyticsTransaction[]>()
  for (const tx of transactions) {
    if (tx.recurringSeriesId === null || tx.bookingDate > end) continue
    bySeries.set(tx.recurringSeriesId, [...(bySeries.get(tx.recurringSeriesId) ?? []), tx])
  }
  for (const s of series) {
    if (s.direction !== 'ausgang' || s.state !== 'aktiv') continue
    const txs = (bySeries.get(s.id) ?? []).sort((a, b) => (a.bookingDate < b.bookingDate ? -1 : 1))
    const last = txs.at(-1)
    if (!last || monthOf(last.bookingDate) !== month) continue
    // Neu ist ein Abo in dem Monat, in dem es zum ersten Mal als Serie erkennbar ist.
    if (txs.length === MIN_OCCURRENCES[s.cadence]) {
      result.push({
        kind: 'neues_abo',
        title: `Neu: ${s.counterparty}, ${euro(-s.typicalAmountCents)} ${CADENCE_LABEL[s.cadence]}.`,
        potId: null,
        seriesId: s.id,
        amountCents: -s.typicalAmountCents,
        referenceCents: null,
      })
      continue
    }
    const prev = txs.at(-2)
    if (!prev) continue
    const now = -last.amountCents
    const before = -prev.amountCents
    if (
      before > 0 &&
      now - before >= PRICE_INCREASE_MIN_CENTS &&
      (now - before) * 10_000 >= before * PRICE_INCREASE_BP
    ) {
      result.push({
        kind: 'preis_erhoeht',
        title: `${s.counterparty} kostet jetzt ${euro(now)} statt ${euro(before)}.`,
        potId: null,
        seriesId: s.id,
        amountCents: now,
        referenceCents: before,
      })
    }
  }
  const order: Record<AnomalyKind, number> = { ausgaben_hoch: 0, preis_erhoeht: 1, neues_abo: 2 }
  return result.sort(
    (a, b) =>
      order[a.kind] - order[b.kind] ||
      b.amountCents - (b.referenceCents ?? 0) - (a.amountCents - (a.referenceCents ?? 0)),
  )
}

// --- Ziele mit Prognose -------------------------------------------------------------

export type GoalStatus = 'erreicht' | 'im_plan' | 'verspaetet' | 'ohne_sparrate'

export interface GoalForecast {
  potId: string
  name: string
  targetCents: number
  savedCents: number
  remainingCents: number
  progressBp: number
  targetMonth: Month | null
  /** Durchschnittliche Zuweisung der letzten 3 Monate (einschließlich des laufenden) */
  monthlyRateCents: number
  /** Monat, in dem das Ziel bei dieser Rate erreicht ist */
  projectedMonth: Month | null
  /** Was ab dem nächsten Monat monatlich nötig wäre, um den Zielmonat zu halten */
  requiredMonthlyCents: number | null
  status: GoalStatus
}

/** Monate, über die die Sparrate gemittelt wird. */
export const GOAL_RATE_MONTHS = 3

export function goalForecast(
  goal: { potId: string; name: string; targetCents: number; targetMonth: Month | null },
  savedCents: number,
  assignments: { month: Month; amountCents: number }[],
  current: Month,
): GoalForecast {
  const saved = Math.max(0, savedCents)
  const remaining = Math.max(0, goal.targetCents - saved)
  const window = monthRange(addMonthsTo(current, -(GOAL_RATE_MONTHS - 1)), current)
  const rate = Math.max(
    0,
    Math.round(
      assignments.filter((a) => window.includes(a.month)).reduce((n, a) => n + a.amountCents, 0) /
        GOAL_RATE_MONTHS,
    ),
  )
  const monthsLeft = goal.targetMonth === null ? null : monthsBetween(current, goal.targetMonth)
  const required =
    monthsLeft === null || remaining === 0
      ? monthsLeft === null
        ? null
        : 0
      : monthsLeft <= 0
        ? remaining
        : Math.ceil(remaining / monthsLeft)
  let projected: Month | null
  let status: GoalStatus
  if (remaining === 0) {
    projected = current
    status = 'erreicht'
  } else if (rate === 0) {
    projected = null
    status = 'ohne_sparrate'
  } else {
    projected = addMonthsTo(current, Math.ceil(remaining / rate))
    status = goal.targetMonth === null || projected <= goal.targetMonth ? 'im_plan' : 'verspaetet'
  }
  return {
    potId: goal.potId,
    name: goal.name,
    targetCents: goal.targetCents,
    savedCents: saved,
    remainingCents: remaining,
    progressBp: Math.min(10_000, shareBp(saved, goal.targetCents) ?? 0),
    targetMonth: goal.targetMonth,
    monthlyRateCents: rate,
    projectedMonth: projected,
    requiredMonthlyCents: required,
    status,
  }
}

// --- Besitzkosten -------------------------------------------------------------------

export interface AssetCosts {
  /** Nettokosten im Zeitraum (positiv = kostet), aus den verknüpften Töpfen */
  costCents: number
  /** davon aus wiederkehrenden Buchungen */
  recurringCostCents: number
  monthlyAverageCents: number
  pots: { potId: string; costCents: number }[]
}

export function assetCosts(
  transactions: AnalyticsTransaction[],
  potIds: string[],
  from: Month,
  to: Month,
): AssetCosts {
  const ids = new Set(potIds)
  const perPot = new Map<string, number>(potIds.map((id) => [id, 0]))
  let recurring = 0
  for (const tx of transactions) {
    const m = monthOf(tx.bookingDate)
    if (m < from || m > to) continue
    for (const s of tx.splits) {
      if (s.kind !== 'topf' || s.potId === null || !ids.has(s.potId)) continue
      perPot.set(s.potId, (perPot.get(s.potId) ?? 0) - s.amountCents)
      if (tx.recurringSeriesId !== null) recurring -= s.amountCents
    }
  }
  const cost = [...perPot.values()].reduce((n, v) => n + v, 0)
  const months = monthsBetween(from, to) + 1
  return {
    costCents: cost,
    recurringCostCents: recurring,
    monthlyAverageCents: Math.round(cost / months),
    pots: [...perPot.entries()].map(([potId, costCents]) => ({ potId, costCents })),
  }
}
