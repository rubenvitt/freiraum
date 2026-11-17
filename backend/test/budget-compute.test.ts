import { describe, expect, it } from 'vitest'
import {
  type BudgetData,
  computeMonth,
  erstIchAssignments,
  type PotPlan,
  planFor,
  readyToAssignFor,
} from '../src/budget/compute.js'
import { addMonthsTo, isMonth, monthsBetween } from '../src/budget/months.js'

// Alle Beträge sind erfunden.

const pot = (id: string, extra: Partial<PotPlan> = {}): PotPlan => ({
  id,
  kind: 'monatlich',
  amountCents: null,
  percentBp: null,
  targetMonth: null,
  ...extra,
})

const data = (d: Partial<BudgetData>): BudgetData => ({
  pots: [],
  assignments: [],
  activity: [],
  inflows: [],
  ...d,
})

describe('Monate', () => {
  it('rechnet über Jahresgrenzen', () => {
    expect(addMonthsTo('2026-11', 2)).toBe('2027-01')
    expect(addMonthsTo('2026-01', -1)).toBe('2025-12')
    expect(monthsBetween('2026-11', '2027-02')).toBe(3)
    expect(isMonth('2026-13')).toBe(false)
    expect(isMonth('2026-02')).toBe(true)
  })
})

describe('Budgetrechnung', () => {
  it('rechnet Verfügbar = Übertrag + Zuweisung + Ausgaben und trägt über', () => {
    const d = data({
      pots: [pot('essen')],
      inflows: [{ month: '2026-10', amountCents: 100_000 }],
      assignments: [
        { potId: 'essen', month: '2026-10', amountCents: 40_000, source: 'manuell' },
        { potId: 'essen', month: '2026-11', amountCents: 30_000, source: 'manuell' },
      ],
      activity: [
        { potId: 'essen', month: '2026-10', amountCents: -35_000 },
        { potId: 'essen', month: '2026-11', amountCents: -10_000 },
      ],
    })
    const oct = computeMonth(d, '2026-10')
    expect(oct.pots[0]).toMatchObject({
      carryoverCents: 0,
      assignedCents: 40_000,
      activityCents: -35_000,
      availableCents: 5_000,
    })
    const nov = computeMonth(d, '2026-11')
    expect(nov.pots[0]).toMatchObject({
      carryoverCents: 5_000,
      assignedCents: 30_000,
      availableCents: 25_000,
    })
    // 100 000 Einnahmen − 70 000 zugewiesen
    expect(nov.readyToAssignCents).toBe(30_000)
    // Im Oktober ist die Novemberzuweisung schon vergeben.
    expect(oct.readyToAssignCents).toBe(30_000)
    expect(oct.assignedInFutureCents).toBe(30_000)
  })

  it('setzt einen überzogenen Topf im Folgemonat auf 0 und mindert dort „Noch ohne Aufgabe“', () => {
    const d = data({
      pots: [pot('tanken')],
      inflows: [{ month: '2026-10', amountCents: 50_000 }],
      assignments: [{ potId: 'tanken', month: '2026-10', amountCents: 10_000, source: 'manuell' }],
      activity: [{ potId: 'tanken', month: '2026-10', amountCents: -12_500 }],
    })
    const oct = computeMonth(d, '2026-10')
    expect(oct.pots[0]?.availableCents).toBe(-2_500)
    expect(oct.readyToAssignCents).toBe(40_000)
    const nov = computeMonth(d, '2026-11')
    expect(nov.pots[0]).toMatchObject({ carryoverCents: 0, availableCents: 0 })
    expect(nov.overspentPreviousCents).toBe(2_500)
    expect(nov.readyToAssignCents).toBe(37_500)
  })

  it('zählt einen Monat ohne Daten mit (Übertrag läuft durch)', () => {
    const d = data({
      pots: [pot('urlaub', { kind: 'ruecklage', amountCents: 120_000 })],
      inflows: [{ month: '2026-08', amountCents: 20_000 }],
      assignments: [{ potId: 'urlaub', month: '2026-08', amountCents: 10_000, source: 'manuell' }],
    })
    expect(computeMonth(d, '2026-11').pots[0]).toMatchObject({
      carryoverCents: 10_000,
      availableCents: 10_000,
      planCents: 10_000,
      neededCents: 10_000,
    })
  })

  it('verplant Geld eines späteren Monats nicht rückwirkend', () => {
    const d = data({
      pots: [pot('essen')],
      inflows: [{ month: '2026-11', amountCents: 10_000 }],
    })
    // Im Oktober war das Novembergeld noch nicht da.
    expect(readyToAssignFor(d, '2026-10', '2026-11')).toBe(0)
    expect(readyToAssignFor(d, '2026-11', '2026-11')).toBe(10_000)
    // Für einen künftigen Monat zählt, was heute da ist.
    expect(readyToAssignFor(d, '2026-12', '2026-11')).toBe(10_000)
  })
})

describe('Plan je Topf-Typ', () => {
  it('Rücklage: ein Zwölftel des Jahresbetrags, aufgerundet', () => {
    expect(planFor(pot('x', { kind: 'ruecklage', amountCents: 100_001 }), '2026-11', 0, 0)).toBe(
      8_334,
    )
  })

  it('Ziel: Rest gleichmäßig auf die Monate bis zum Zielmonat', () => {
    const goal = pot('x', { kind: 'ziel', amountCents: 120_000, targetMonth: '2027-02' })
    // November bis Februar = 4 Monate, 20 000 schon da
    expect(planFor(goal, '2026-11', 20_000, 0)).toBe(25_000)
    // Im Zielmonat und danach: der ganze Rest
    expect(planFor(goal, '2027-02', 100_000, 0)).toBe(20_000)
    expect(planFor(goal, '2027-05', 100_000, 0)).toBe(20_000)
    // Ohne Zielmonat kein Monatsplan
    expect(planFor(pot('y', { kind: 'ziel', amountCents: 1_000 }), '2026-11', 0, 0)).toBe(0)
  })

  it('Erst ich: fester Betrag oder Anteil der Einnahmen', () => {
    expect(planFor(pot('x', { kind: 'erst_ich', amountCents: 30_000 }), '2026-11', 0, 0)).toBe(
      30_000,
    )
    expect(planFor(pot('x', { kind: 'erst_ich', percentBp: 1_500 }), '2026-11', 0, 301_999)).toBe(
      45_299,
    )
  })
})

describe('Erst-ich-Automatik', () => {
  const investieren = pot('investieren', { kind: 'erst_ich', percentBp: 1_000 })
  const notgroschen = pot('notgroschen', { kind: 'erst_ich', amountCents: 50_000 })

  it('füllt Erst-ich-Töpfe in Reihenfolge, solange Geld ohne Aufgabe da ist', () => {
    const d = data({
      pots: [investieren, notgroschen, pot('essen')],
      inflows: [{ month: '2026-11', amountCents: 300_000 }],
      assignments: [{ potId: 'essen', month: '2026-11', amountCents: 230_000, source: 'manuell' }],
    })
    const result = erstIchAssignments(d, ['investieren', 'notgroschen'], '2026-11', '2026-11')
    // 70 000 frei: 30 000 (10 %) fürs Investieren, der Rest reicht nur für 40 000 Notgroschen.
    expect(Object.fromEntries(result)).toEqual({ investieren: 30_000, notgroschen: 40_000 })
  })

  it('rechnet frühere Automatik-Beträge neu und lässt eigene Zuweisungen stehen', () => {
    const d = data({
      pots: [investieren, notgroschen],
      inflows: [{ month: '2026-11', amountCents: 100_000 }],
      assignments: [
        { potId: 'investieren', month: '2026-11', amountCents: 30_000, source: 'automatik' },
        { potId: 'notgroschen', month: '2026-11', amountCents: 5_000, source: 'manuell' },
      ],
    })
    const result = erstIchAssignments(d, ['investieren', 'notgroschen'], '2026-11', '2026-11')
    expect(Object.fromEntries(result)).toEqual({ investieren: 10_000 })
  })
})
