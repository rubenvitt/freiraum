/**
 * Auswertungen (E5) und Besitz. Alles ist je Haushalt; Zugriff haben nur seine Mitglieder
 * (sonst 404, wie im Budget). Die Rechnung steckt in `compute.ts`, hier wird nur geladen.
 *
 * Eine Freigabe öffnet keine Auswertung: Auch mit der Sicht `budget` bleiben Auswertungen des
 * privaten Haushalts der anderen Person „nicht gefunden“. Was eine Person freigibt, sind
 * Kennzahlen als Anteile (`CoupleService.metrics`). Der Geldfluss über Haushalte hinweg gehört
 * nur der Person selbst (FREI-22).
 */
import type { TransactionSql } from 'postgres'
import { computeMonth } from '../budget/compute.js'
import { addMonthsTo, firstDay, type Month, monthOf, monthsBetween } from '../budget/months.js'
import type { BudgetService } from '../budget/service.js'
import { cents } from '../db/cents.js'
import type { Db } from '../db/client.js'
import { ApiError } from '../errors.js'
import { type IsoDate, todayUtc } from '../ledger/dates.js'
import {
  type AnalyticsPot,
  type AnalyticsSeries,
  type AnalyticsTransaction,
  type Anomaly,
  anomalies,
  assetCosts,
  classify,
  type Flow,
  flow,
  type GoalForecast,
  goalForecast,
  type MetricsTotals,
  type MonthMetrics,
  monthlyMetrics,
  monthRange,
  type PersonFlow,
  personFlow,
  type Runway,
  runway,
  shareBp,
} from './compute.js'

type Sql = Db | TransactionSql

/** Längster Zeitraum einer Auswertung in Monaten. */
export const MAX_RANGE_MONTHS = 120

export interface MetricsView {
  householdId: string
  from: Month
  to: Month
  months: MonthMetrics[]
  totals: MetricsTotals
  runway: Runway
}

export interface FlowView extends Flow {
  householdId: string
  from: Month
  to: Month
}

export interface PersonFlowView extends PersonFlow {
  personId: string
  from: Month
  to: Month
}

export interface AnomaliesView {
  householdId: string
  month: Month
  items: Anomaly[]
}

export interface GoalsView {
  householdId: string
  month: Month
  items: GoalForecast[]
}

export interface Asset {
  id: string
  householdId: string
  name: string
  valueCents: number | null
  sortOrder: number
  potIds: string[]
  archived: boolean
  createdAt: Date
}

export interface AssetInput {
  name: string
  valueCents?: number | null | undefined
  potIds?: string[] | undefined
  sortOrder?: number | undefined
}

export type AssetPatch = Partial<AssetInput> & { archived?: boolean | undefined }

export type AssetClassification = 'verbindlichkeit' | 'vermoegenswert' | 'neutral'

export interface AssetCostView {
  assetId: string
  name: string
  valueCents: number | null
  costCents: number
  recurringCostCents: number
  monthlyAverageCents: number
  /** Jahreskosten (Monatsschnitt × 12) im Verhältnis zum Wert, null ohne Wert */
  annualCostOfValueBp: number | null
  classification: AssetClassification
  pots: { potId: string; name: string; costCents: number }[]
}

export interface OwnershipCostsView {
  householdId: string
  from: Month
  to: Month
  items: AssetCostView[]
  totalCostCents: number
  /** Anteil der Besitzkosten am Konsum im Zeitraum */
  shareOfConsumptionBp: number | null
}

interface AssetRow {
  id: string
  household_id: string
  name: string
  value_cents: string | null
  sort_order: number
  archived_at: Date | null
  created_at: Date
  pot_ids: string[]
}

const toAsset = (r: AssetRow): Asset => ({
  id: r.id,
  householdId: r.household_id,
  name: r.name,
  valueCents: r.value_cents === null ? null : cents(r.value_cents),
  sortOrder: r.sort_order,
  potIds: r.pot_ids,
  archived: r.archived_at !== null,
  createdAt: r.created_at,
})

const personNotFound = () =>
  new ApiError(404, 'person_nicht_gefunden', 'Diese Person gibt es nicht.')

const assetNotFound = () =>
  new ApiError(404, 'besitz_nicht_gefunden', 'Diesen Besitz gibt es nicht.')

const pgCode = (err: unknown) =>
  typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined

/** Prüft einen Zeitraum aus der Anfrage. */
export function checkRange(from: Month, to: Month): void {
  if (from > to) {
    throw new ApiError(422, 'zeitraum_ungueltig', 'Der Anfang liegt nach dem Ende.')
  }
  if (monthsBetween(from, to) + 1 > MAX_RANGE_MONTHS) {
    throw new ApiError(
      422,
      'zeitraum_zu_lang',
      `Höchstens ${MAX_RANGE_MONTHS} Monate auf einmal auswerten.`,
    )
  }
}

export class AnalyticsService {
  constructor(
    private readonly db: Db,
    private readonly budget: BudgetService,
  ) {}

  // --- Laden ----------------------------------------------------------------------

  private async householdName(sql: Sql, householdId: string): Promise<string> {
    const [row] = await sql<
      { name: string }[]
    >`select name from households where id = ${householdId}`
    return row?.name ?? ''
  }

  /** Anzeigenamen der Mitglieder eines Haushalts (für Einzahlungen im Gemeinsamen). */
  private async memberNames(sql: Sql, householdId: string): Promise<Map<string, string>> {
    const rows = await sql<{ id: string; display_name: string }[]>`
      select p.id, p.display_name from household_members m join persons p on p.id = m.person_id
      where m.household_id = ${householdId}
    `
    return new Map(rows.map((r) => [r.id, r.display_name]))
  }

  private async pots(sql: Sql, householdId: string): Promise<AnalyticsPot[]> {
    const rows = await sql<
      {
        id: string
        name: string
        kind: AnalyticsPot['kind']
        group_name: string | null
        archived_at: Date | null
      }[]
    >`
      select id, name, kind, group_name, archived_at from pots
      where household_id = ${householdId}
      order by sort_order, created_at
    `
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      groupName: r.group_name,
      archived: r.archived_at !== null,
    }))
  }

  /**
   * Alle Buchungen des Haushalts mit Aufteilungen (Mengen sind klein: zwei Personen). Dazu, als
   * `offAccount`, was über Haushaltsgrenzen hinweg zählt (FREI-22):
   * - Aufteilungen von Buchungen anderer Haushalte in eigenen Töpfen (privat bezahlte gemeinsame
   *   Ausgaben bzw. umgekehrt, ADR 0006). Nur der Anteil im eigenen Topf, ohne Gegenpartei:
   *   Mehr als der Ausgleich zeigt, verlässt den anderen Haushalt nicht.
   * - Verrechnungen mit der Einzahlung (FREI-28), im Monat von `settled_on`: im gemeinsamen
   *   Haushalt als Einzahlung der Person, im privaten als Einzahlung ins Gemeinsame.
   */
  private async transactions(sql: Sql, householdId: string): Promise<AnalyticsTransaction[]> {
    type SplitJson = {
      kind: AnalyticsTransaction['splits'][number]['kind']
      potId: string | null
      personId: string | null
      amountCents: number
    }
    const rows = await sql<
      {
        id: string
        booking_date: string
        amount_cents: string
        counterparty: string | null
        recurring_series_id: string | null
        off_account: boolean
        splits: SplitJson[]
      }[]
    >`
      select t.id, t.booking_date::text, t.amount_cents,
             coalesce(t.counterparty_name, t.counterparty_iban) as counterparty,
             t.recurring_series_id, false as off_account,
             coalesce(
               json_agg(json_build_object('kind', s.kind, 'potId', s.pot_id,
                                          'personId', s.person_id,
                                          'amountCents', s.amount_cents))
                 filter (where s.id is not null),
               '[]'
             ) as splits
      from transactions t
      join accounts a on a.id = t.account_id
      left join transaction_splits s on s.transaction_id = t.id
      where a.household_id = ${householdId}
      group by t.id
      union all
      select t.id, t.booking_date::text, sum(s.amount_cents), null, t.recurring_series_id, true,
             json_agg(json_build_object('kind', s.kind, 'potId', s.pot_id, 'personId', null,
                                        'amountCents', s.amount_cents))
      from transaction_splits s
      join pots p on p.id = s.pot_id
      join transactions t on t.id = s.transaction_id
      join accounts a on a.id = t.account_id
      where p.household_id = ${householdId} and a.household_id <> ${householdId}
      group by t.id
      order by 2, 1
    `
    const offsets = await sql<
      { id: string; settled_on: string; person_id: string; shared: boolean; amount_cents: string }[]
    >`
      select s.id, s.settled_on::text, s.person_id, s.household_id = ${householdId} as shared,
             s.amount_cents
      from settlements s
      where s.kind = 'verrechnung'
        and (s.household_id = ${householdId}
             or s.person_id = (select owner_person_id from households
                               where id = ${householdId} and kind = 'privat'))
    `
    const booked = rows.map(
      (r): AnalyticsTransaction => ({
        id: r.id,
        bookingDate: r.booking_date,
        amountCents: cents(r.amount_cents),
        counterparty: r.counterparty,
        recurringSeriesId: r.recurring_series_id,
        splits: r.splits.map((s) => ({ ...s, amountCents: cents(s.amountCents) })),
        offAccount: r.off_account,
      }),
    )
    // Positiv = verrechnete Forderung (mehr Einzahlung), negativ = verrechnete Schuld.
    const offset = offsets.map((o): AnalyticsTransaction => {
      const amount = (o.shared ? 1 : -1) * cents(o.amount_cents)
      return {
        id: `verrechnung:${o.id}`,
        bookingDate: o.settled_on,
        amountCents: amount,
        counterparty: null,
        recurringSeriesId: null,
        splits: [
          {
            kind: 'einzahlung',
            potId: null,
            personId: o.shared ? o.person_id : null,
            amountCents: amount,
          },
        ],
        offAccount: true,
      }
    })
    return [...booked, ...offset].sort((a, b) =>
      a.bookingDate === b.bookingDate
        ? a.id.localeCompare(b.id)
        : a.bookingDate < b.bookingDate
          ? -1
          : 1,
    )
  }

  private async series(sql: Sql, householdId: string): Promise<AnalyticsSeries[]> {
    const rows = await sql<
      {
        id: string
        counterparty: string
        direction: 'eingang' | 'ausgang'
        cadence: AnalyticsSeries['cadence']
        typical_amount_cents: string
        state: 'aktiv' | 'beendet'
      }[]
    >`
      select s.id, s.counterparty, s.direction, s.cadence, s.typical_amount_cents, s.state
      from recurring_series s
      join accounts a on a.id = s.account_id
      where a.household_id = ${householdId}
    `
    return rows.map((r) => ({
      id: r.id,
      counterparty: r.counterparty,
      direction: r.direction,
      cadence: r.cadence,
      typicalAmountCents: cents(r.typical_amount_cents),
      state: r.state,
    }))
  }

  /**
   * Geld des Haushalts laut Budget: „Noch ohne Aufgabe“ (mit Anfangsbestand) + Zuweisungen
   * späterer Monate + alle Töpfe, dazu noch nicht zugeordnete Buchungen ab dem Budgetbeginn.
   */
  private async cash(
    sql: Sql,
    householdId: string,
    transactions: AnalyticsTransaction[],
    current: Month,
  ): Promise<number> {
    const data = await this.budget.loadData(sql, householdId)
    const month = computeMonth(data, current)
    const inPots = month.pots.reduce((n, p) => n + p.availableCents, 0)
    const start = data.start?.month ?? null
    // Wie im Budget zählt nur, was ab dem Budgetbeginn gebucht ist; davor steckt alles im
    // Anfangsbestand.
    const unassigned = transactions
      .filter((t) => {
        const m = monthOf(t.bookingDate)
        return t.splits.length === 0 && m <= current && (start === null || m >= start)
      })
      .reduce((n, t) => n + t.amountCents, 0)
    return month.readyToAssignCents + month.assignedInFutureCents + inPots + unassigned
  }

  /**
   * Feste Einzahlungen der Person eines privaten Haushalts ins Gemeinsame, die im Monat gelten
   * (je gemeinsamem Haushalt die jüngste Regel bis zum Monat). Eine Regel „Prozent vom Netto“
   * zählt nicht: Ohne Einkommen fällt sie weg. Gemeinsame Haushalte zahlen nichts ein.
   */
  private async fixedContributions(sql: Sql, householdId: string, month: Month): Promise<number> {
    const [row] = await sql<{ amount_cents: string }[]>`
      select coalesce(sum(latest.amount_cents), 0) as amount_cents
      from (
        select distinct on (r.household_id) r.kind, r.amount_cents
        from households h
        join contribution_rules r on r.person_id = h.owner_person_id
        join household_members m on m.household_id = r.household_id and m.person_id = r.person_id
        where h.id = ${householdId} and h.kind = 'privat' and r.valid_from <= ${firstDay(month)}
        order by r.household_id, r.valid_from desc
      ) latest
      where latest.kind = 'fest'
    `
    return row ? cents(row.amount_cents) : 0
  }

  // --- Auswertungen ---------------------------------------------------------------

  /**
   * Kennzahlen eines Haushalts für einen Monat, **ohne Zugriffsprüfung**: nur für Dienste, die
   * selbst prüfen, was die anfragende Person sehen darf (Freigaben im Paar-Modell).
   */
  async monthMetricsUnchecked(householdId: string, month: Month): Promise<MonthMetrics> {
    const pots = await this.pots(this.db, householdId)
    const transactions = await this.transactions(this.db, householdId)
    const { months } = monthlyMetrics(transactions, pots, month, month, todayUtc())
    const [metrics] = months
    if (!metrics) throw new Error('Kennzahlen für den Monat fehlen')
    return metrics
  }

  async metrics(
    personId: string,
    householdId: string,
    from: Month,
    to: Month,
    asOf: IsoDate = todayUtc(),
  ): Promise<MetricsView> {
    checkRange(from, to)
    await this.budget.householdAccess(this.db, personId, householdId)
    const pots = await this.pots(this.db, householdId)
    const transactions = await this.transactions(this.db, householdId)
    const { months, totals } = monthlyMetrics(transactions, pots, from, to, asOf)
    const cash = await this.cash(this.db, householdId, transactions, monthOf(asOf))
    const contributions = await this.fixedContributions(this.db, householdId, monthOf(asOf))
    return {
      householdId,
      from,
      to,
      months,
      totals,
      runway: runway(transactions, pots, cash, asOf, contributions),
    }
  }

  async flow(personId: string, householdId: string, from: Month, to: Month): Promise<FlowView> {
    checkRange(from, to)
    await this.budget.householdAccess(this.db, personId, householdId)
    const pots = await this.pots(this.db, householdId)
    const transactions = await this.transactions(this.db, householdId)
    const name = await this.householdName(this.db, householdId)
    const personNames = await this.memberNames(this.db, householdId)
    return { householdId, from, to, ...flow(transactions, pots, name, from, to, { personNames }) }
  }

  /**
   * Geldfluss einer Person über ihre Haushalte (FREI-22): Einkommen → privat → Einzahlung →
   * gemeinsam → gemeinsame Töpfe. Nur für die Person selbst: Er zeigt Beträge aus ihrem privaten
   * Haushalt, und dafür gibt es keine Freigabe. Für jede andere Person 404.
   */
  async personFlow(
    viewerId: string,
    personId: string,
    from: Month,
    to: Month,
  ): Promise<PersonFlowView> {
    checkRange(from, to)
    if (viewerId !== personId) throw personNotFound()
    const households = await this.db<{ id: string; name: string; kind: 'privat' | 'gemeinsam' }[]>`
      select h.id, h.name, h.kind from households h
      join household_members m on m.household_id = h.id and m.person_id = ${personId}
      order by h.kind desc, h.created_at, h.id
    `
    const own = households.find((h) => h.kind === 'privat')
    if (!own) throw personNotFound()
    const load = async (h: { id: string; name: string }) => ({
      householdId: h.id,
      name: h.name,
      pots: await this.pots(this.db, h.id),
      transactions: await this.transactions(this.db, h.id),
    })
    const shared = []
    for (const h of households.filter((x) => x.kind === 'gemeinsam')) {
      shared.push({ ...(await load(h)), personNames: await this.memberNames(this.db, h.id) })
    }
    return { personId, from, to, ...personFlow(personId, await load(own), shared, from, to) }
  }

  async anomalies(personId: string, householdId: string, month: Month): Promise<AnomaliesView> {
    await this.budget.householdAccess(this.db, personId, householdId)
    const pots = await this.pots(this.db, householdId)
    const transactions = await this.transactions(this.db, householdId)
    const series = await this.series(this.db, householdId)
    return { householdId, month, items: anomalies(transactions, pots, series, month) }
  }

  async goals(
    personId: string,
    householdId: string,
    asOf: IsoDate = todayUtc(),
  ): Promise<GoalsView> {
    await this.budget.householdAccess(this.db, personId, householdId)
    const current = monthOf(asOf)
    const data = await this.budget.loadData(this.db, householdId)
    const month = computeMonth(data, current)
    const items = data.potRows
      .filter((p) => p.kind === 'ziel' && !p.archived && p.amountCents !== null)
      .map((p) =>
        goalForecast(
          {
            potId: p.id,
            name: p.name,
            targetCents: p.amountCents as number,
            targetMonth: p.targetMonth,
          },
          month.pots.find((row) => row.potId === p.id)?.availableCents ?? 0,
          data.assignments.filter((a) => a.potId === p.id),
          current,
        ),
      )
    return { householdId, month: current, items }
  }

  async ownershipCosts(
    personId: string,
    householdId: string,
    from: Month,
    to: Month,
  ): Promise<OwnershipCostsView> {
    checkRange(from, to)
    await this.budget.householdAccess(this.db, personId, householdId)
    const assets = (await this.loadAssets(this.db, householdId)).filter((a) => !a.archived)
    const pots = await this.pots(this.db, householdId)
    const potNames = new Map(pots.map((p) => [p.id, p.name]))
    const potKinds = new Map(pots.map((p) => [p.id, p.kind]))
    const transactions = await this.transactions(this.db, householdId)
    const items = assets.map((asset): AssetCostView => {
      const c = assetCosts(transactions, asset.potIds, from, to)
      return {
        assetId: asset.id,
        name: asset.name,
        valueCents: asset.valueCents,
        costCents: c.costCents,
        recurringCostCents: c.recurringCostCents,
        monthlyAverageCents: c.monthlyAverageCents,
        annualCostOfValueBp:
          asset.valueCents === null ? null : shareBp(c.monthlyAverageCents * 12, asset.valueCents),
        classification:
          c.costCents > 0 ? 'verbindlichkeit' : c.costCents < 0 ? 'vermoegenswert' : 'neutral',
        pots: c.pots.map((p) => ({ ...p, name: potNames.get(p.potId) ?? '' })),
      }
    })
    const months = new Set(monthRange(from, to))
    const consumption = transactions
      .filter((t) => months.has(monthOf(t.bookingDate)))
      .reduce((n, t) => n + classify(t, potKinds).consumptionCents, 0)
    const total = items.reduce((n, i) => n + i.costCents, 0)
    return {
      householdId,
      from,
      to,
      items,
      totalCostCents: total,
      shareOfConsumptionBp: shareBp(total, consumption),
    }
  }

  // --- Besitz ---------------------------------------------------------------------

  private async loadAssets(sql: Sql, householdId: string, assetId?: string): Promise<Asset[]> {
    const rows = await sql<AssetRow[]>`
      select a.id, a.household_id, a.name, a.value_cents, a.sort_order, a.archived_at,
             a.created_at,
             coalesce(array_agg(ap.pot_id order by p.sort_order, p.created_at)
                        filter (where ap.pot_id is not null), '{}') as pot_ids
      from assets a
      left join asset_pots ap on ap.asset_id = a.id
      left join pots p on p.id = ap.pot_id
      where a.household_id = ${householdId}
        ${assetId ? sql`and a.id = ${assetId}` : sql``}
      group by a.id
      order by a.sort_order, a.created_at
    `
    return rows.map(toAsset)
  }

  private async accessibleAsset(sql: Sql, personId: string, assetId: string): Promise<Asset> {
    const [row] = await sql<{ household_id: string }[]>`
      select a.household_id from assets a
      join household_members m on m.household_id = a.household_id and m.person_id = ${personId}
      where a.id = ${assetId}
    `
    if (!row) throw assetNotFound()
    const [asset] = await this.loadAssets(sql, row.household_id, assetId)
    if (!asset) throw assetNotFound()
    return asset
  }

  async listAssets(personId: string, householdId: string, includeArchived = false) {
    await this.budget.householdAccess(this.db, personId, householdId)
    const assets = await this.loadAssets(this.db, householdId)
    return includeArchived ? assets : assets.filter((a) => !a.archived)
  }

  private async linkPots(
    tx: TransactionSql,
    householdId: string,
    assetId: string,
    potIds: string[],
  ): Promise<void> {
    const unique = [...new Set(potIds)]
    const found = await tx<{ id: string }[]>`
      select id from pots where household_id = ${householdId} and id = any(${unique}::uuid[])
    `
    if (found.length !== unique.length) {
      throw new ApiError(422, 'topf_fremd', 'Ein Topf gehört nicht zu diesem Haushalt.')
    }
    await tx`delete from asset_pots where asset_id = ${assetId}`
    try {
      for (const potId of unique) {
        await tx`insert into asset_pots (asset_id, pot_id) values (${assetId}, ${potId})`
      }
    } catch (err) {
      if (pgCode(err) === '23505') {
        throw new ApiError(
          409,
          'topf_schon_verknuepft',
          'Ein Topf gehört schon zu einem anderen Besitz.',
        )
      }
      throw err
    }
  }

  private nameTaken(err: unknown): never {
    if (pgCode(err) === '23505') {
      throw new ApiError(
        409,
        'besitz_name_vergeben',
        'Einen Besitz mit diesem Namen gibt es schon.',
      )
    }
    throw err
  }

  async createAsset(personId: string, householdId: string, input: AssetInput): Promise<Asset> {
    return this.db.begin(async (tx) => {
      await this.budget.householdAccess(tx, personId, householdId, true)
      let id: string
      try {
        const [row] = await tx<{ id: string }[]>`
          insert into assets (household_id, name, value_cents, sort_order)
          values (${householdId}, ${input.name.trim()}, ${input.valueCents ?? null},
                  ${input.sortOrder ?? 0})
          returning id
        `
        if (!row) throw new Error('Besitz konnte nicht angelegt werden')
        id = row.id
      } catch (err) {
        this.nameTaken(err)
      }
      await this.linkPots(tx, householdId, id, input.potIds ?? [])
      const [asset] = await this.loadAssets(tx, householdId, id)
      if (!asset) throw assetNotFound()
      return asset
    })
  }

  async updateAsset(personId: string, assetId: string, patch: AssetPatch): Promise<Asset> {
    const asset = await this.accessibleAsset(this.db, personId, assetId)
    return this.db.begin(async (tx) => {
      await this.budget.householdAccess(tx, personId, asset.householdId, true)
      try {
        await tx`
          update assets set
            name = ${patch.name?.trim() ?? asset.name},
            value_cents = ${patch.valueCents === undefined ? asset.valueCents : patch.valueCents},
            sort_order = ${patch.sortOrder ?? asset.sortOrder},
            archived_at = ${
              patch.archived === undefined
                ? tx`archived_at`
                : patch.archived
                  ? tx`coalesce(archived_at, now())`
                  : null
            }
          where id = ${assetId}
        `
      } catch (err) {
        this.nameTaken(err)
      }
      if (patch.potIds !== undefined) {
        await this.linkPots(tx, asset.householdId, assetId, patch.potIds)
      }
      const [updated] = await this.loadAssets(tx, asset.householdId, assetId)
      if (!updated) throw assetNotFound()
      return updated
    })
  }

  async deleteAsset(personId: string, assetId: string): Promise<void> {
    const asset = await this.accessibleAsset(this.db, personId, assetId)
    await this.db`delete from assets where id = ${asset.id}`
  }
}

/** Standardzeitraum: die letzten `months` Monate bis einschließlich `to`. */
export function defaultFrom(to: Month, months: number): Month {
  return addMonthsTo(to, -(months - 1))
}
