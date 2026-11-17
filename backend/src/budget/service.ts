/**
 * Töpfe, Zuweisungen, Monatsabschluss und Erst-ich-Automatik.
 *
 * Zugriff wird hier durchgesetzt: Nur Mitglieder eines Haushalts sehen und ändern seine Töpfe
 * und sein Budget. Fremde Haushalte und Töpfe sind „nicht gefunden“ (404). Einzige Ausnahme:
 * Hat die Inhaberin eines privaten Haushalts der anderen Person die Sicht `budget` freigegeben
 * (ADR 0004), darf diese Töpfe und Budget lesen, aber nichts ändern.
 *
 * Schreibende Vorgänge sperren die Haushaltszeile (`for update`), damit die Prüfung von
 * „Noch ohne Aufgabe ≥ 0“ nicht durch parallele Änderungen unterlaufen wird. Sperrreihenfolge
 * überall: erst Konto, dann Haushalt.
 */
import type { TransactionSql } from 'postgres'
import { cents } from '../db/cents.js'
import type { Db } from '../db/client.js'
import { ApiError } from '../errors.js'
import { type IsoDate, todayUtc } from '../ledger/dates.js'
import {
  type AssignmentSource,
  type BudgetData,
  computeMonth,
  erstIchAssignments,
  firstMonth,
  type MonthBudget,
  type PotKind,
  type PotMonth,
  readyToAssignFor,
} from './compute.js'
import { addMonthsTo, firstDay, type Month, monthOf } from './months.js'

type Sql = Db | TransactionSql

export interface Pot {
  id: string
  householdId: string
  name: string
  kind: PotKind
  groupName: string | null
  amountCents: number | null
  percentBp: number | null
  targetMonth: Month | null
  sortOrder: number
  archived: boolean
  createdAt: Date
}

export interface PotInput {
  name: string
  kind: PotKind
  groupName?: string | null | undefined
  amountCents?: number | null | undefined
  percentBp?: number | null | undefined
  targetMonth?: Month | null | undefined
  sortOrder?: number | undefined
}

export type PotPatch = Partial<Omit<PotInput, 'kind'>> & { archived?: boolean | undefined }

export interface BudgetPotView extends PotMonth {
  name: string
  kind: PotKind
  groupName: string | null
  archived: boolean
}

export interface BudgetMonthView extends Omit<MonthBudget, 'pots'> {
  householdId: string
  closedAt: Date | null
  unconfirmedTransactions: number
  pots: BudgetPotView[]
}

interface PotRow {
  id: string
  household_id: string
  name: string
  kind: PotKind
  group_name: string | null
  amount_cents: string | null
  percent_bp: number | null
  target_month: string | null
  sort_order: number
  archived_at: Date | null
  created_at: Date
}

const POT_COLUMNS = `id, household_id, name, kind, group_name, amount_cents, percent_bp,
  to_char(target_month, 'YYYY-MM') as target_month, sort_order, archived_at, created_at`

const toPot = (r: PotRow): Pot => ({
  id: r.id,
  householdId: r.household_id,
  name: r.name,
  kind: r.kind,
  groupName: r.group_name,
  amountCents: r.amount_cents === null ? null : cents(r.amount_cents),
  percentBp: r.percent_bp,
  targetMonth: r.target_month,
  sortOrder: r.sort_order,
  archived: r.archived_at !== null,
  createdAt: r.created_at,
})

const householdNotFound = () =>
  new ApiError(404, 'haushalt_nicht_gefunden', 'Diesen Haushalt gibt es nicht.')
const potNotFound = () => new ApiError(404, 'topf_nicht_gefunden', 'Diesen Topf gibt es nicht.')

/** Prüft die Planfelder je Topf-Typ und gibt fachliche Fehler auf Deutsch zurück. */
function validatePlan(p: {
  kind: PotKind
  amountCents: number | null
  percentBp: number | null
  targetMonth: Month | null
}): void {
  const fail = (message: string) => new ApiError(422, 'topf_plan_ungueltig', message)
  if (p.kind !== 'erst_ich' && p.percentBp !== null) {
    throw fail('Einen Anteil vom Einkommen gibt es nur bei Erst-ich-Töpfen.')
  }
  if (p.kind !== 'ziel' && p.targetMonth !== null) {
    throw fail('Einen Zielmonat gibt es nur bei Ziel-Töpfen.')
  }
  if (p.kind === 'ruecklage' && p.amountCents === null) {
    throw fail('Eine Rücklage braucht einen Jahresbetrag.')
  }
  if (p.kind === 'ziel' && p.amountCents === null) {
    throw fail('Ein Ziel braucht einen Zielbetrag.')
  }
  if (p.kind === 'erst_ich' && (p.amountCents === null) === (p.percentBp === null)) {
    throw fail('Ein Erst-ich-Topf braucht entweder einen festen Betrag oder einen Anteil.')
  }
}

const isUniqueViolation = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'

export class BudgetService {
  constructor(private readonly db: Db) {}

  // --- Zugriff -----------------------------------------------------------------

  /** Haushalt, sofern die Person Mitglied ist; sonst 404. `lock` sperrt die Zeile. */
  async householdAccess(sql: Sql, personId: string, householdId: string, lock = false) {
    const [row] = lock
      ? await sql<{ id: string }[]>`
          select h.id from households h
          join household_members m on m.household_id = h.id and m.person_id = ${personId}
          where h.id = ${householdId}
          for update of h
        `
      : await sql<{ id: string }[]>`
          select h.id from households h
          join household_members m on m.household_id = h.id and m.person_id = ${personId}
          where h.id = ${householdId}
        `
    if (!row) throw householdNotFound()
  }

  /**
   * Lesender Zugriff: Mitglied, oder der Haushalt ist privat und die Inhaberin hat der Person die
   * Sicht `budget` freigegeben. Sonst 404.
   */
  async householdReadAccess(sql: Sql, personId: string, householdId: string): Promise<void> {
    const [row] = await sql<{ id: string }[]>`
      select h.id from households h
      where h.id = ${householdId}
        and (exists (select 1 from household_members m
                     where m.household_id = h.id and m.person_id = ${personId})
             or (h.kind = 'privat' and exists (
                   select 1 from shares s
                   where s.owner_person_id = h.owner_person_id
                     and s.grantee_person_id = ${personId} and s.scope = 'budget')))
    `
    if (!row) throw householdNotFound()
  }

  private async lockHousehold(tx: TransactionSql, householdId: string): Promise<void> {
    await tx`select id from households where id = ${householdId} for update`
  }

  /** Topf, sofern die Person Mitglied seines Haushalts ist; sonst 404. */
  async accessiblePot(sql: Sql, personId: string, potId: string): Promise<Pot> {
    const [row] = await sql<PotRow[]>`
      select ${sql.unsafe(POT_COLUMNS)} from pots
      where id = ${potId}
        and exists (select 1 from household_members m
                    where m.household_id = pots.household_id and m.person_id = ${personId})
    `
    if (!row) throw potNotFound()
    return toPot(row)
  }

  // --- Töpfe -------------------------------------------------------------------

  async listPots(personId: string, householdId: string, includeArchived = false): Promise<Pot[]> {
    await this.householdReadAccess(this.db, personId, householdId)
    const rows = await this.db<PotRow[]>`
      select ${this.db.unsafe(POT_COLUMNS)} from pots
      where household_id = ${householdId}
        ${includeArchived ? this.db`` : this.db`and archived_at is null`}
      order by sort_order, created_at
    `
    return rows.map(toPot)
  }

  async createPot(
    personId: string,
    householdId: string,
    input: PotInput,
    asOf: IsoDate = todayUtc(),
  ): Promise<Pot> {
    const plan = {
      kind: input.kind,
      amountCents: input.amountCents ?? null,
      percentBp: input.percentBp ?? null,
      targetMonth: input.targetMonth ?? null,
    }
    validatePlan(plan)
    return this.db.begin(async (tx) => {
      await this.householdAccess(tx, personId, householdId, true)
      let row: PotRow | undefined
      try {
        ;[row] = await tx<PotRow[]>`
          insert into pots (household_id, name, kind, group_name, amount_cents, percent_bp,
                            target_month, sort_order)
          values (${householdId}, ${input.name.trim()}, ${plan.kind},
                  ${input.groupName?.trim() || null}, ${plan.amountCents}, ${plan.percentBp},
                  ${plan.targetMonth ? firstDay(plan.targetMonth) : null},
                  ${input.sortOrder ?? 0})
          returning ${tx.unsafe(POT_COLUMNS)}
        `
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ApiError(
            409,
            'topf_name_vergeben',
            'Einen Topf mit diesem Namen gibt es schon.',
          )
        }
        throw err
      }
      if (!row) throw new Error('Topf konnte nicht angelegt werden')
      if (plan.kind === 'erst_ich') await this.runErstIch(tx, householdId, monthOf(asOf), asOf)
      return toPot(row)
    })
  }

  async updatePot(
    personId: string,
    potId: string,
    patch: PotPatch,
    asOf: IsoDate = todayUtc(),
  ): Promise<Pot> {
    const pot = await this.accessiblePot(this.db, personId, potId)
    return this.db.begin(async (tx) => {
      await this.lockHousehold(tx, pot.householdId)
      const plan = {
        kind: pot.kind,
        amountCents: patch.amountCents === undefined ? pot.amountCents : patch.amountCents,
        percentBp: patch.percentBp === undefined ? pot.percentBp : patch.percentBp,
        targetMonth: patch.targetMonth === undefined ? pot.targetMonth : patch.targetMonth,
      }
      validatePlan(plan)
      const current = monthOf(asOf)
      if (patch.archived === true && !pot.archived) {
        const data = await this.loadData(tx, pot.householdId)
        const row = computeMonth(data, current).pots.find((p) => p.potId === potId)
        if (row && row.availableCents !== 0) {
          throw new ApiError(
            409,
            'topf_nicht_leer',
            'Im Topf liegt noch Geld (oder er ist überzogen). Erst umschichten, dann archivieren.',
          )
        }
      }
      const groupName =
        patch.groupName === undefined ? pot.groupName : patch.groupName?.trim() || null
      let row: PotRow | undefined
      try {
        ;[row] = await tx<PotRow[]>`
          update pots set
            name = ${patch.name?.trim() ?? pot.name},
            group_name = ${groupName},
            amount_cents = ${plan.amountCents},
            percent_bp = ${plan.percentBp},
            target_month = ${plan.targetMonth ? firstDay(plan.targetMonth) : null},
            sort_order = ${patch.sortOrder ?? pot.sortOrder},
            archived_at = ${
              patch.archived === undefined
                ? tx`archived_at`
                : patch.archived
                  ? tx`coalesce(archived_at, now())`
                  : null
            }
          where id = ${potId}
          returning ${tx.unsafe(POT_COLUMNS)}
        `
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ApiError(
            409,
            'topf_name_vergeben',
            'Einen Topf mit diesem Namen gibt es schon.',
          )
        }
        throw err
      }
      if (!row) throw potNotFound()
      if (pot.kind === 'erst_ich') await this.runErstIch(tx, pot.householdId, current, asOf)
      return toPot(row)
    })
  }

  // --- Budgetdaten -------------------------------------------------------------

  /** Alles, was die Budgetrechnung eines Haushalts braucht (Mengen sind klein: zwei Personen). */
  async loadData(sql: Sql, householdId: string): Promise<BudgetData & { potRows: Pot[] }> {
    const pots = (
      await sql<PotRow[]>`
        select ${sql.unsafe(POT_COLUMNS)} from pots
        where household_id = ${householdId}
        order by sort_order, created_at
      `
    ).map(toPot)
    const assignments = await sql<
      { pot_id: string; month: string; amount_cents: string; source: AssignmentSource }[]
    >`
      select a.pot_id, to_char(a.month, 'YYYY-MM') as month, a.amount_cents, a.source
      from pot_assignments a join pots p on p.id = a.pot_id
      where p.household_id = ${householdId}
    `
    const activity = await sql<{ pot_id: string; month: string; amount_cents: string }[]>`
      select s.pot_id, to_char(t.booking_date, 'YYYY-MM') as month,
             sum(s.amount_cents) as amount_cents
      from transaction_splits s
      join transactions t on t.id = s.transaction_id
      join pots p on p.id = s.pot_id
      where s.kind = 'topf' and p.household_id = ${householdId}
      group by 1, 2
    `
    // Einnahmen; im Gemeinsamen zählen Einzahlungen der Personen dazu (positiv). Einzahlungen
    // von privaten Konten (negativ) mindern „Noch ohne Aufgabe“ getrennt (ADR 0004).
    const inflows = await sql<{ month: string; amount_cents: string }[]>`
      select to_char(t.booking_date, 'YYYY-MM') as month, sum(s.amount_cents) as amount_cents
      from transaction_splits s
      join transactions t on t.id = s.transaction_id
      join accounts a on a.id = t.account_id
      where a.household_id = ${householdId}
        and (s.kind = 'einnahme' or (s.kind = 'einzahlung' and s.amount_cents > 0))
      group by 1
    `
    const contributions = await sql<{ month: string; amount_cents: string }[]>`
      select to_char(t.booking_date, 'YYYY-MM') as month, sum(s.amount_cents) as amount_cents
      from transaction_splits s
      join transactions t on t.id = s.transaction_id
      join accounts a on a.id = t.account_id
      where a.household_id = ${householdId} and s.kind = 'einzahlung' and s.amount_cents < 0
      group by 1
    `
    return {
      potRows: pots,
      pots: pots.map((p) => ({
        id: p.id,
        kind: p.kind,
        amountCents: p.amountCents,
        percentBp: p.percentBp,
        targetMonth: p.targetMonth,
      })),
      assignments: assignments.map((a) => ({
        potId: a.pot_id,
        month: a.month,
        amountCents: cents(a.amount_cents),
        source: a.source,
      })),
      activity: activity.map((a) => ({
        potId: a.pot_id,
        month: a.month,
        amountCents: cents(a.amount_cents),
      })),
      inflows: inflows.map((i) => ({ month: i.month, amountCents: cents(i.amount_cents) })),
      contributions: contributions.map((c) => ({
        month: c.month,
        amountCents: cents(c.amount_cents),
      })),
    }
  }

  private async closedMonths(sql: Sql, householdId: string): Promise<Map<Month, Date>> {
    const rows = await sql<{ month: string; closed_at: Date }[]>`
      select to_char(month, 'YYYY-MM') as month, closed_at from month_closings
      where household_id = ${householdId}
    `
    return new Map(rows.map((r) => [r.month, r.closed_at]))
  }

  private async view(sql: Sql, householdId: string, month: Month): Promise<BudgetMonthView> {
    const data = await this.loadData(sql, householdId)
    const budget = computeMonth(data, month)
    const closed = await this.closedMonths(sql, householdId)
    const [pending] = await sql<{ n: number }[]>`
      select count(*)::int as n from transactions t
      join accounts a on a.id = t.account_id
      where a.household_id = ${householdId} and t.status <> 'bestaetigt'
        and t.booking_date >= ${firstDay(month)}
        and t.booking_date < ${firstDay(addMonthsTo(month, 1))}
    `
    const byId = new Map(data.potRows.map((p) => [p.id, p]))
    const pots = budget.pots
      .map((row) => {
        const pot = byId.get(row.potId) as Pot
        return {
          ...row,
          name: pot.name,
          kind: pot.kind,
          groupName: pot.groupName,
          archived: pot.archived,
        }
      })
      // Archivierte Töpfe nur zeigen, solange sich in diesem Monat noch etwas in ihnen bewegt.
      .filter(
        (p) =>
          !p.archived ||
          p.carryoverCents !== 0 ||
          p.assignedCents !== 0 ||
          p.activityCents !== 0 ||
          p.availableCents !== 0,
      )
    return {
      ...budget,
      householdId,
      closedAt: closed.get(month) ?? null,
      unconfirmedTransactions: pending?.n ?? 0,
      pots,
    }
  }

  async getMonth(personId: string, householdId: string, month: Month): Promise<BudgetMonthView> {
    await this.householdReadAccess(this.db, personId, householdId)
    return this.view(this.db, householdId, month)
  }

  // --- Zuweisungen -------------------------------------------------------------

  /**
   * Zuweisung eines Topfs für einen Monat setzen. Eine Erhöhung ist nur erlaubt, solange
   * „Noch ohne Aufgabe“ im Monat (und im laufenden Monat, falls später) nicht negativ wird.
   * Senken geht immer, auch wenn „Noch ohne Aufgabe“ schon negativ ist.
   */
  async setAssignment(
    personId: string,
    householdId: string,
    month: Month,
    potId: string,
    amountCents: number,
    asOf: IsoDate = todayUtc(),
  ): Promise<BudgetMonthView> {
    return this.db.begin(async (tx) => {
      await this.householdAccess(tx, personId, householdId, true)
      const pot = await this.accessiblePot(tx, personId, potId)
      if (pot.householdId !== householdId) throw potNotFound()
      if ((await this.closedMonths(tx, householdId)).has(month)) {
        throw new ApiError(409, 'monat_abgeschlossen', `Der Monat ${month} ist abgeschlossen.`)
      }
      const data = await this.loadData(tx, householdId)
      const previous = data.assignments.find((a) => a.potId === potId && a.month === month)
      const delta = amountCents - (previous?.amountCents ?? 0)
      if (delta > 0 && pot.archived) {
        throw new ApiError(
          422,
          'topf_archiviert',
          'Einem archivierten Topf wird nichts zugewiesen.',
        )
      }
      if (delta > 0) {
        const next: BudgetData = {
          ...data,
          assignments: [
            ...data.assignments.filter((a) => !(a.potId === potId && a.month === month)),
            { potId, month, amountCents, source: 'manuell' },
          ],
        }
        const ready = readyToAssignFor(next, month, monthOf(asOf))
        if (ready < 0) {
          throw new ApiError(
            422,
            'noch_ohne_aufgabe_negativ',
            `Dafür ist nicht genug Geld ohne Aufgabe da (es fehlen ${-ready} Cent).`,
          )
        }
      }
      await tx`
        insert into pot_assignments (pot_id, month, amount_cents, source, updated_by)
        values (${potId}, ${firstDay(month)}, ${amountCents}, 'manuell', ${personId})
        on conflict (pot_id, month) do update set
          amount_cents = excluded.amount_cents, source = 'manuell',
          updated_by = excluded.updated_by, updated_at = now()
      `
      return this.view(tx, householdId, month)
    })
  }

  // --- Erst-ich-Automatik ------------------------------------------------------

  /** Automatik von Hand anstoßen (z. B. nach dem Senken anderer Zuweisungen). */
  async fillErstIch(
    personId: string,
    householdId: string,
    month: Month,
    asOf: IsoDate = todayUtc(),
  ): Promise<BudgetMonthView> {
    return this.db.begin(async (tx) => {
      await this.householdAccess(tx, personId, householdId, true)
      if ((await this.closedMonths(tx, householdId)).has(month)) {
        throw new ApiError(409, 'monat_abgeschlossen', `Der Monat ${month} ist abgeschlossen.`)
      }
      await this.runErstIch(tx, householdId, month, asOf)
      return this.view(tx, householdId, month)
    })
  }

  /**
   * Erst-ich-Töpfe für einen Monat neu füllen. Läuft nach jeder Änderung der Einnahmen
   * (Kategorisierung, Bestätigung) und nach Änderungen an Erst-ich-Töpfen. Abgeschlossene
   * Monate bleiben unberührt. Erwartet eine offene Transaktion; sperrt den Haushalt.
   */
  async runErstIch(
    tx: TransactionSql,
    householdId: string,
    month: Month,
    asOf: IsoDate = todayUtc(),
  ): Promise<void> {
    await this.lockHousehold(tx, householdId)
    if ((await this.closedMonths(tx, householdId)).has(month)) return
    const data = await this.loadData(tx, householdId)
    const potIds = data.potRows.filter((p) => p.kind === 'erst_ich' && !p.archived).map((p) => p.id)
    if (potIds.length === 0) return
    const amounts = erstIchAssignments(data, potIds, month, monthOf(asOf))
    for (const [potId, amount] of amounts) {
      const previous = data.assignments.find((a) => a.potId === potId && a.month === month)
      if (previous?.amountCents === amount) continue
      if (amount === 0) {
        await tx`
          delete from pot_assignments
          where pot_id = ${potId} and month = ${firstDay(month)} and source = 'automatik'
        `
        continue
      }
      await tx`
        insert into pot_assignments (pot_id, month, amount_cents, source, updated_by)
        values (${potId}, ${firstDay(month)}, ${amount}, 'automatik', null)
        on conflict (pot_id, month) do update set
          amount_cents = excluded.amount_cents, updated_at = now(), updated_by = null
        where pot_assignments.source = 'automatik'
      `
    }
  }

  // --- Monatsabschluss ---------------------------------------------------------

  /**
   * Monat abschließen: nur vergangene Monate, in Reihenfolge, und nur ohne unbestätigte
   * Buchungen. Danach nimmt der Monat keine Zuweisungen mehr an. Der Stand wird festgehalten.
   */
  async closeMonth(
    personId: string,
    householdId: string,
    month: Month,
    asOf: IsoDate = todayUtc(),
  ): Promise<BudgetMonthView> {
    return this.db.begin(async (tx) => {
      await this.householdAccess(tx, personId, householdId, true)
      if (month >= monthOf(asOf)) {
        throw new ApiError(
          409,
          'monat_laeuft_noch',
          'Abschließen geht erst, wenn der Monat vorbei ist.',
        )
      }
      const closed = await this.closedMonths(tx, householdId)
      if (closed.has(month)) {
        throw new ApiError(
          409,
          'monat_abgeschlossen',
          `Der Monat ${month} ist schon abgeschlossen.`,
        )
      }
      const start = firstMonth(await this.loadData(tx, householdId))
      if (start !== null) {
        for (let m = start; m < month; m = addMonthsTo(m, 1)) {
          if (!closed.has(m)) {
            throw new ApiError(
              409,
              'vormonat_offen',
              `Erst den Monat ${m} abschließen, Monate werden der Reihe nach abgeschlossen.`,
            )
          }
        }
      }
      const view = await this.view(tx, householdId, month)
      if (view.unconfirmedTransactions > 0) {
        throw new ApiError(
          409,
          'offene_buchungen',
          `Im Monat ${month} warten noch ${view.unconfirmedTransactions} Buchungen auf Bestätigung.`,
        )
      }
      const { closedAt: _, unconfirmedTransactions: __, ...snapshot } = view
      await tx`
        insert into month_closings (household_id, month, closed_by, snapshot)
        values (${householdId}, ${firstDay(month)}, ${personId}, ${tx.json(snapshot as never)})
      `
      return this.view(tx, householdId, month)
    })
  }

  /** Abschluss zurücknehmen, nur für den zuletzt abgeschlossenen Monat. */
  async reopenMonth(personId: string, householdId: string, month: Month): Promise<BudgetMonthView> {
    return this.db.begin(async (tx) => {
      await this.householdAccess(tx, personId, householdId, true)
      const closed = await this.closedMonths(tx, householdId)
      if (!closed.has(month)) {
        throw new ApiError(409, 'monat_nicht_abgeschlossen', `Der Monat ${month} ist offen.`)
      }
      if ([...closed.keys()].some((m) => m > month)) {
        throw new ApiError(
          409,
          'spaeterer_monat_abgeschlossen',
          'Nur der zuletzt abgeschlossene Monat kann wieder geöffnet werden.',
        )
      }
      await tx`
        delete from month_closings where household_id = ${householdId} and month = ${firstDay(month)}
      `
      return this.view(tx, householdId, month)
    })
  }
}
