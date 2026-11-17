/**
 * Budgetrechnung eines Haushalts, als reine Funktion über die gesamte Historie.
 *
 * Regeln (ADR 0003):
 * - Verfügbar im Topf = Übertrag + Zuweisung + Ausgaben des Monats (Ausgaben negativ).
 * - Übertrag = Verfügbar des Vormonats, aber nie negativ: Überziehung setzt den Topf im
 *   Folgemonat auf 0 und mindert stattdessen „Noch ohne Aufgabe“ ab dem Folgemonat.
 * - Noch ohne Aufgabe(M) = Anfangsbestand + Einnahmen bis M − Zuweisungen bis M
 *   − Zuweisungen nach M − Überziehung der Monate vor M. Geld, das in einem späteren Monat
 *   verplant ist, ist auch heute schon vergeben.
 * - Budgetbeginn: Daten vor dem Startmonat zählen nicht. Der Anfangsbestand (Summe der
 *   Kontostände zum Start) kommt im Startmonat in „Noch ohne Aufgabe“, ist aber keine Einnahme
 *   des Monats (zählt also nicht für Erst-ich-Anteile).
 */
import { addMonthsTo, type Month, maxMonth, minMonth, monthsBetween } from './months.js'

export type PotKind = 'monatlich' | 'ruecklage' | 'ziel' | 'erst_ich'
export type AssignmentSource = 'manuell' | 'automatik'

export interface PotPlan {
  id: string
  kind: PotKind
  amountCents: number | null
  percentBp: number | null
  targetMonth: Month | null
}

export interface BudgetData {
  pots: PotPlan[]
  assignments: { potId: string; month: Month; amountCents: number; source: AssignmentSource }[]
  /** Summe der Topf-Aufteilungen je Topf und Monat (Ausgaben negativ, Erstattungen positiv). */
  activity: { potId: string; month: Month; amountCents: number }[]
  /** Summe der Einnahme-Aufteilungen je Monat. */
  inflows: { month: Month; amountCents: number }[]
  /**
   * Budgetbeginn: Startmonat und Anfangsbestand. Alles vor dem Startmonat wird ignoriert.
   * Fehlt er, rechnet das Budget über die gesamte Historie.
   */
  start?: { month: Month; openingBalanceCents: number } | null | undefined
}

export interface PotMonth {
  potId: string
  carryoverCents: number
  assignedCents: number
  assignmentSource: AssignmentSource | null
  activityCents: number
  availableCents: number
  /** Was der Plan des Topfs für diesen Monat vorsieht. */
  planCents: number
  /** Was dafür in diesem Monat noch zuzuweisen wäre. */
  neededCents: number
}

export interface MonthBudget {
  month: Month
  /** Anfangsbestand, nur im Startmonat (sonst 0). */
  openingBalanceCents: number
  inflowsCents: number
  readyToAssignCents: number
  assignedCents: number
  activityCents: number
  overspentPreviousCents: number
  assignedInFutureCents: number
  pots: PotMonth[]
}

const key = (potId: string, month: Month) => `${potId}|${month}`

/** Plan eines Topfs für den Monat (siehe ADR 0003). */
export function planFor(
  pot: PotPlan,
  month: Month,
  carryoverCents: number,
  inflowsCents: number,
): number {
  switch (pot.kind) {
    case 'monatlich':
      return pot.amountCents ?? 0
    case 'ruecklage':
      return Math.ceil((pot.amountCents ?? 0) / 12)
    case 'ziel': {
      if (pot.amountCents === null || pot.targetMonth === null) return 0
      const missing = Math.max(0, pot.amountCents - carryoverCents)
      const monthsLeft = monthsBetween(month, pot.targetMonth) + 1
      return monthsLeft <= 1 ? missing : Math.ceil(missing / monthsLeft)
    }
    case 'erst_ich':
      if (pot.amountCents !== null) return pot.amountCents
      return Math.floor(((pot.percentBp ?? 0) * Math.max(0, inflowsCents)) / 10_000)
  }
}

/** Erster Monat, in dem der Haushalt Budgetdaten hat (oder null). */
export function firstMonth(data: BudgetData): Month | null {
  const months = [
    ...data.assignments.map((a) => a.month),
    ...data.activity.map((a) => a.month),
    ...data.inflows.map((i) => i.month),
  ]
  return months.length === 0 ? null : months.reduce(minMonth)
}

/** Daten ab dem Budgetbeginn; ohne Budgetbeginn unverändert. */
export function fromStart(data: BudgetData): BudgetData {
  const start = data.start?.month
  if (!start) return data
  return {
    ...data,
    assignments: data.assignments.filter((a) => a.month >= start),
    activity: data.activity.filter((a) => a.month >= start),
    inflows: data.inflows.filter((i) => i.month >= start),
  }
}

/** Budget eines Monats vor dem Budgetbeginn: alles 0. */
function emptyMonth(data: BudgetData, month: Month): MonthBudget {
  return {
    month,
    openingBalanceCents: 0,
    inflowsCents: 0,
    readyToAssignCents: 0,
    assignedCents: 0,
    activityCents: 0,
    overspentPreviousCents: 0,
    assignedInFutureCents: 0,
    pots: data.pots.map((pot) => ({
      potId: pot.id,
      carryoverCents: 0,
      assignedCents: 0,
      assignmentSource: null,
      activityCents: 0,
      availableCents: 0,
      planCents: 0,
      neededCents: 0,
    })),
  }
}

export function computeMonth(all: BudgetData, month: Month): MonthBudget {
  const startMonth = all.start?.month ?? null
  if (startMonth !== null && month < startMonth) return emptyMonth(all, month)
  const data = fromStart(all)
  const opening = all.start?.openingBalanceCents ?? 0
  const assigned = new Map<string, { amountCents: number; source: AssignmentSource }>()
  for (const a of data.assignments) assigned.set(key(a.potId, a.month), a)
  const activity = new Map<string, number>()
  for (const a of data.activity) {
    activity.set(key(a.potId, a.month), (activity.get(key(a.potId, a.month)) ?? 0) + a.amountCents)
  }
  const inflows = new Map<Month, number>()
  for (const i of data.inflows) inflows.set(i.month, (inflows.get(i.month) ?? 0) + i.amountCents)

  // Vor den ersten Daten ändert sich nichts; die Rechnung darf dort beginnen.
  const first = firstMonth(data) ?? month
  const start = minMonth(startMonth === null ? first : maxMonth(startMonth, first), month)
  const available = new Map<string, number>()
  let inflowsUpTo = 0
  let assignedUpTo = 0
  let overspentBefore = 0
  let overspentPrevious = 0
  let result: PotMonth[] = []
  let monthActivity = 0
  let monthAssigned = 0

  for (let m = start; m <= month; m = addMonthsTo(m, 1)) {
    const isTarget = m === month
    let overspent = 0
    const rows: PotMonth[] = []
    monthActivity = 0
    monthAssigned = 0
    for (const pot of data.pots) {
      const carry = Math.max(0, available.get(pot.id) ?? 0)
      const a = assigned.get(key(pot.id, m))
      const act = activity.get(key(pot.id, m)) ?? 0
      const avail = carry + (a?.amountCents ?? 0) + act
      available.set(pot.id, avail)
      overspent += Math.max(0, -avail)
      monthActivity += act
      monthAssigned += a?.amountCents ?? 0
      if (isTarget) {
        const plan = planFor(pot, m, carry, inflows.get(m) ?? 0)
        rows.push({
          potId: pot.id,
          carryoverCents: carry,
          assignedCents: a?.amountCents ?? 0,
          assignmentSource: a?.source ?? null,
          activityCents: act,
          availableCents: avail,
          planCents: plan,
          neededCents: Math.max(0, plan - (a?.amountCents ?? 0)),
        })
      }
    }
    inflowsUpTo += inflows.get(m) ?? 0
    assignedUpTo += monthAssigned
    if (isTarget) {
      result = rows
    } else {
      overspentBefore += overspent
      overspentPrevious = overspent
    }
  }

  const assignedInFuture = data.assignments
    .filter((a) => a.month > month)
    .reduce((sum, a) => sum + a.amountCents, 0)

  return {
    month,
    openingBalanceCents: month === startMonth ? opening : 0,
    inflowsCents: inflows.get(month) ?? 0,
    readyToAssignCents: opening + inflowsUpTo - assignedUpTo - assignedInFuture - overspentBefore,
    assignedCents: monthAssigned,
    activityCents: monthActivity,
    overspentPreviousCents: start === month ? 0 : overspentPrevious,
    assignedInFutureCents: assignedInFuture,
    pots: result,
  }
}

/**
 * Erst-ich-Automatik: Zuweisungen der Erst-ich-Töpfe für `month`. Die Töpfe werden in der
 * gegebenen Reihenfolge bis zu ihrem Plan gefüllt, solange „Noch ohne Aufgabe“ reicht.
 * Bisherige Automatik-Beträge werden dabei neu berechnet (sinken also, wenn eine Einnahme
 * wegfällt). Töpfe, denen eine Person in diesem Monat selbst zugewiesen hat, bleiben unberührt.
 */
export function erstIchAssignments(
  data: BudgetData,
  potIds: string[],
  month: Month,
  current: Month,
): Map<string, number> {
  const manual = new Set(
    data.assignments.filter((a) => a.month === month && a.source === 'manuell').map((a) => a.potId),
  )
  const eligible = potIds
    .map((id) => data.pots.find((p) => p.id === id))
    .filter((p): p is PotPlan => p?.kind === 'erst_ich' && !manual.has(p.id))
  const ids = new Set(eligible.map((p) => p.id))
  const without: BudgetData = {
    ...data,
    assignments: data.assignments.filter((a) => !(a.month === month && ids.has(a.potId))),
  }
  const inflows = data.inflows
    .filter((i) => i.month === month)
    .reduce((sum, i) => sum + i.amountCents, 0)
  let room = readyToAssignFor(without, month, current)
  const result = new Map<string, number>()
  for (const pot of eligible) {
    const amount = Math.min(planFor(pot, month, 0, inflows), Math.max(0, room))
    result.set(pot.id, amount)
    room -= amount
  }
  return result
}

/**
 * „Noch ohne Aufgabe“ in den Monaten, die eine Zuweisung im Monat `month` berührt: dem Monat
 * selbst und dem laufenden Monat, falls er später liegt. Geld aus einem späteren Monat darf
 * nicht rückwirkend verteilt werden, und was heute da ist, darf nicht doppelt vergeben werden.
 */
export function readyToAssignFor(data: BudgetData, month: Month, current: Month): number {
  const own = computeMonth(data, month).readyToAssignCents
  if (current <= month) return own
  return Math.min(own, computeMonth(data, current).readyToAssignCents)
}
